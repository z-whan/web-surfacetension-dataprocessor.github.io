(function () {
  const config = window.SurfaceLabConfig;
  const APP_ROOT = "/surface_lab";
  const PY_ROOT = APP_ROOT + "/py";
  const UPLOAD_ROOT = APP_ROOT + "/uploads";

  let pyodideInstance = null;
  let bridgeModule = null;
  let runtimeInitPromise = null;
  let micropipReady = false;
  const installedOptionalPackages = new Set();

  function ensureDir(fs, dirPath) {
    const parts = dirPath.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      try {
        fs.mkdir(current);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        if (!message.includes("File exists")) {
          throw new Error(
            "Failed to create runtime directory '" +
              current +
              "' while preparing '" +
              dirPath +
              "': " +
              normalizeError(error)
          );
        }
      }
    }
  }

  function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
  }

  function normalizeError(error) {
    if (!error) {
      return "Unknown error";
    }
    if (typeof error === "string") {
      return error;
    }
    if (error.message) {
      return error.message;
    }
    if (error.name === "ErrnoError" && typeof error.errno !== "undefined") {
      return "Filesystem error (" + error.name + ", errno=" + error.errno + ")";
    }
    if (typeof error.toString === "function" && error.toString !== Object.prototype.toString) {
      const text = error.toString();
      if (text && text !== "[object Object]") {
        return text;
      }
    }
    try {
      return JSON.stringify(error, null, 2);
    } catch (_jsonError) {
      return String(error);
    }
  }

  function convertResult(result) {
    if (!result || typeof result !== "object") {
      return result;
    }

    if (typeof result.toJs === "function") {
      const jsValue = result.toJs({ dict_converter: Object.fromEntries });
      if (typeof result.destroy === "function") {
        result.destroy();
      }
      return jsValue;
    }

    return result;
  }

  function marshalArgument(arg) {
    if (!pyodideInstance) {
      return { value: arg, proxy: null };
    }

    if (arg === null || arg === undefined) {
      return { value: arg, proxy: null };
    }

    if (Array.isArray(arg) || Object.prototype.toString.call(arg) === "[object Object]") {
      const proxy = pyodideInstance.toPy(arg);
      return { value: proxy, proxy };
    }

    return { value: arg, proxy: null };
  }

  function mirrorPythonSources(pyodide) {
    const sources = window.__PYTHON_SOURCES__ || {};
    ensureDir(pyodide.FS, PY_ROOT);

    Object.keys(sources).forEach((relativePath) => {
      const fsPath = APP_ROOT + "/" + relativePath;
      const directory = fsPath.slice(0, fsPath.lastIndexOf("/"));
      ensureDir(pyodide.FS, directory);
      pyodide.FS.writeFile(fsPath, sources[relativePath], { encoding: "utf8" });
    });
  }

  async function installRuntimePackages(pyodide) {
    await pyodide.loadPackage(config.PYTHON_PACKAGES);
  }

  async function ensureMicropip() {
    if (micropipReady) {
      return;
    }
    await pyodideInstance.loadPackage(["micropip"]);
    micropipReady = true;
  }

  async function ensureOptionalPackages(packages) {
    if (!packages || !packages.length) {
      return;
    }
    if (!pyodideInstance) {
      throw new Error("Python runtime is not ready yet.");
    }

    const missingPackages = packages.filter((pkg) => !installedOptionalPackages.has(pkg));
    if (!missingPackages.length) {
      return;
    }

    await ensureMicropip();
    pyodideInstance.globals.set("optional_packages", missingPackages);

    try {
      await pyodideInstance.runPythonAsync(
        "import micropip\nawait micropip.install(optional_packages.to_py())\n"
      );
      missingPackages.forEach((pkg) => installedOptionalPackages.add(pkg));
    } catch (error) {
      throw new Error("Optional Python package installation failed: " + normalizeError(error));
    } finally {
      pyodideInstance.globals.delete("optional_packages");
    }
  }

  function loadPyodideScript() {
    if (window.loadPyodide) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = config.PYODIDE_INDEX_URL + "pyodide.js";
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load Pyodide runtime."));
      document.head.appendChild(script);
    });
  }

  async function initRuntime(onStatus, force) {
    if (force) {
      runtimeInitPromise = null;
      bridgeModule = null;
      pyodideInstance = null;
      micropipReady = false;
      installedOptionalPackages.clear();
    }

    if (runtimeInitPromise) {
      return runtimeInitPromise;
    }

    runtimeInitPromise = (async () => {
      onStatus("Loading Pyodide runtime...");
      await loadPyodideScript();

      pyodideInstance = await window.loadPyodide({ indexURL: config.PYODIDE_INDEX_URL });
      ensureDir(pyodideInstance.FS, APP_ROOT);
      ensureDir(pyodideInstance.FS, UPLOAD_ROOT);

      onStatus("Installing Python packages...");
      await installRuntimePackages(pyodideInstance);

      onStatus("Syncing bundled Python modules...");
      mirrorPythonSources(pyodideInstance);

      onStatus("Booting analysis bridge...");
      await pyodideInstance.runPythonAsync(
        'import sys\nif "' + PY_ROOT + '" not in sys.path:\n    sys.path.insert(0, "' + PY_ROOT + '")\n'
      );

      bridgeModule = pyodideInstance.pyimport("web_bridge");
      const metadata = await callBridge("get_runtime_metadata");
      onStatus("Python runtime ready.");
      return metadata;
    })().catch((error) => {
      runtimeInitPromise = null;
      bridgeModule = null;
      pyodideInstance = null;
      micropipReady = false;
      installedOptionalPackages.clear();
      throw new Error(normalizeError(error));
    });

    return runtimeInitPromise;
  }

  async function stageBrowserFile(file, scope) {
    if (!pyodideInstance) {
      throw new Error("Python runtime is not ready yet.");
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const directory = UPLOAD_ROOT + "/" + (scope || "shared");
    ensureDir(pyodideInstance.FS, directory);

    const token = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const fsPath = directory + "/" + token + "-" + sanitizeFilename(file.name);
    pyodideInstance.FS.writeFile(fsPath, bytes, { encoding: "binary" });

    return {
      originalName: file.name,
      fsPath,
      size: file.size,
      type: file.type,
    };
  }

  async function callBridge(method) {
    if (!bridgeModule) {
      throw new Error("Python bridge is unavailable.");
    }

    const fn = bridgeModule[method];
    if (typeof fn !== "function") {
      throw new Error("Unknown Python bridge method: " + method);
    }

    const args = Array.prototype.slice.call(arguments, 1);
    const marshalled = args.map(marshalArgument);

    try {
      const result = fn.apply(
        null,
        marshalled.map((item) => item.value)
      );
      return convertResult(result);
    } finally {
      marshalled.forEach((item) => {
        if (item.proxy && typeof item.proxy.destroy === "function") {
          item.proxy.destroy();
        }
      });
    }
  }

  function readBinaryFile(fsPath) {
    if (!pyodideInstance) {
      throw new Error("Python runtime is not ready yet.");
    }
    return pyodideInstance.FS.readFile(fsPath, { encoding: "binary" });
  }

  function removeFsFile(fsPath) {
    if (!pyodideInstance) {
      return;
    }
    try {
      pyodideInstance.FS.unlink(fsPath);
    } catch (_error) {
      // Ignore stale cleanup attempts.
    }
  }

  window.SurfaceLabPyodide = {
    initRuntime,
    ensureOptionalPackages,
    normalizeError,
    stageBrowserFile,
    callBridge,
    readBinaryFile,
    removeFsFile,
  };
})();
