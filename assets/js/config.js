(function () {
  window.SurfaceLabConfig = {
    PYODIDE_VERSION: "0.29.3",
    PYODIDE_INDEX_URL: "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/",
    PYTHON_PACKAGES: ["numpy", "pandas"],
    OPTIONAL_PYTHON_PACKAGES: {
      xlsx: ["openpyxl"],
      xls: ["xlrd"],
    },
    ACCEPTED_DATA_EXTENSIONS: ".csv,.xlsx,.xls",
  };
})();
