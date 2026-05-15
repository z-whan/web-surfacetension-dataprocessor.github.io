(function () {
  const PRESETS = {
    fast: {
      plateauSearchStrideMs: 10000,
      nBootstrap: 0,
      fitSeriesMaxPoints: 150,
    },
    standard: {
      plateauSearchStrideMs: 5000,
      nBootstrap: 100,
      fitSeriesMaxPoints: 250,
    },
    full: {
      plateauSearchStrideMs: 1000,
      nBootstrap: 300,
      fitSeriesMaxPoints: 400,
    },
  };

  const FLAG_LABELS = {
    NO_VALID_DATA: "NO_DATA",
    NO_PLATEAU: "NO_PLATEAU",
    HIGH_FINAL_DRIFT: "DRIFT",
    HIGH_NOISE: "NOISE",
    HIGH_VOLUME_LOSS: "EVAP",
    HIGH_EVAPORATION: "EVAP",
    OUTLIER_WITHIN_CONCENTRATION: "OUTLIER",
    NO_VOLUME_DATA: "NO_VOLUME",
    LOW_POINT_COUNT: "LOW_N",
  };

  const FLAG_DESCRIPTIONS = {
    NO_VALID_DATA: "No valid surface tension data were available. Default: excluded.",
    NO_PLATEAU: "No equilibrium plateau window could be found. Default: excluded.",
    HIGH_FINAL_DRIFT: "Plateau slope exceeds the configured drift threshold. Default: excluded.",
    HIGH_NOISE: "Plateau standard deviation exceeds the configured noise threshold. Default: excluded.",
    HIGH_VOLUME_LOSS: "Full-droplet volume loss exceeds the configured threshold. Default: excluded.",
    HIGH_EVAPORATION: "Full-droplet evaporation rate exceeds the configured threshold. Default: excluded.",
    OUTLIER_WITHIN_CONCENTRATION: "Droplet is an outlier within its concentration group. Default: excluded.",
    NO_VOLUME_DATA: "No droplet volume data were found. Default: warning only.",
    LOW_POINT_COUNT: "Few points were available in the plateau window. Default: warning only.",
  };

  function fileIdentity(file) {
    return {
      name: file && file.name ? file.name : "",
      size: file && Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
      lastModified: file && Number.isFinite(Number(file.lastModified)) ? Number(file.lastModified) : 0,
    };
  }

  function fileKey(file) {
    const id = fileIdentity(file);
    return [id.name, id.size, id.lastModified].join("|");
  }

  function appendFileRows(rows, files, inferConcentration) {
    const next = rows.slice();
    const seen = new Set(next.map((row) => row.fileKey || fileKey(row.file)));
    Array.from(files || []).forEach((file) => {
      const key = fileKey(file);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      next.push({
        file,
        fileKey: key,
        filename: file.name,
        size: file.size,
        lastModified: file.lastModified || 0,
        concentration: inferConcentration ? inferConcentration(file.name) : "",
      });
    });
    return next;
  }

  function presetOptions(name) {
    return { ...(PRESETS[name] || PRESETS.standard) };
  }

  function reviewCacheKey(rows, reviewOptions) {
    return JSON.stringify({
      files: rows.map((row) => ({
        name: row.filename,
        size: row.size,
        lastModified: row.lastModified || (row.file ? row.file.lastModified || 0 : 0),
      })),
      plateauMode: reviewOptions.plateauMode,
      minPlateauWindowMs: reviewOptions.minPlateauWindowMs,
      plateauSearchStrideMs: reviewOptions.plateauSearchStrideMs,
      maxAbsSlopeMnMPerMin: reviewOptions.maxAbsSlopeMnMPerMin,
      maxPlateauSdMnM: reviewOptions.maxPlateauSdMnM,
      maxVolumeLossPct: reviewOptions.maxVolumeLossPct,
      maxEvaporationRatePctPerMin: reviewOptions.maxEvaporationRatePctPerMin,
      densityOverrideGPerCm3: reviewOptions.densityOverrideGPerCm3 || "",
      manualWindow: reviewOptions.plateauMode === "manual"
        ? {
            tMin: reviewOptions.tMinText || "",
            tMax: reviewOptions.tMaxText || "",
          }
        : null,
    });
  }

  function dropletKey(row, droplet) {
    return [
      row && row.fileKey ? row.fileKey : "",
      droplet && droplet.sourceColumn ? droplet.sourceColumn : "",
      droplet && droplet.dropletIndex != null ? droplet.dropletIndex : "",
    ].join("::");
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function applyUsedOverrides(reviewPayload, rows, usedOverrides) {
    const cloned = cloneJson(reviewPayload);
    const overrides = usedOverrides || {};
    (cloned.files || []).forEach((file, fileIndex) => {
      const row = rows[fileIndex] || {};
      (file.droplets || []).forEach((droplet) => {
        const key = dropletKey(row, droplet);
        const qc = droplet.qc || {};
        const defaultUsed = Boolean(qc.usedForAggregate);
        if (Object.prototype.hasOwnProperty.call(overrides, key)) {
          const used = Boolean(overrides[key]);
          qc.usedForAggregate = used;
          qc.manualOverride = true;
          qc.defaultUsedForAggregate = defaultUsed;
          droplet.usedForAggregate = used;
          droplet.manualOverride = true;
          droplet.defaultUsedForAggregate = defaultUsed;
        } else {
          droplet.usedForAggregate = defaultUsed;
        }
        droplet.stableDropletId = key;
        droplet.qc = qc;
      });
    });
    cloned.droplets = (cloned.files || []).flatMap((file) => file.droplets || []);
    cloned.qc = cloned.droplets.map((droplet) => droplet.qc || {});
    return cloned;
  }

  function sortRowsByConcentration(rows, direction) {
    const dir = direction === "desc" ? "desc" : "asc";
    return rows.slice().sort((left, right) => {
      const a = Number(left.concentration);
      const b = Number(right.concentration);
      const aValid = Number.isFinite(a);
      const bValid = Number.isFinite(b);
      if (aValid && bValid && a !== b) {
        return dir === "asc" ? a - b : b - a;
      }
      if (aValid !== bValid) {
        return aValid ? -1 : 1;
      }
      return String(left.filename).localeCompare(String(right.filename));
    });
  }

  function flagLabel(flag) {
    return FLAG_LABELS[flag] || String(flag || "FLAG");
  }

  function flagTitle(flag, qc, options) {
    const values = [];
    if (qc) {
      if (flag === "HIGH_FINAL_DRIFT") {
        values.push("slope=" + qc.slopeMnMPerMin);
        values.push("threshold=" + (options && options.maxAbsSlopeMnMPerMin));
      }
      if (flag === "HIGH_NOISE") {
        values.push("SD=" + qc.gammaSd);
        values.push("threshold=" + (options && options.maxPlateauSdMnM));
      }
      if (flag === "HIGH_VOLUME_LOSS") {
        values.push("full loss=" + qc.fullVolumeLossPct + "%");
        values.push("threshold=" + (options && options.maxVolumeLossPct) + "%");
      }
      if (flag === "HIGH_EVAPORATION") {
        values.push("rate=" + qc.fullEvaporationRatePctPerMin + "%/min");
        values.push("threshold=" + (options && options.maxEvaporationRatePctPerMin) + "%/min");
      }
    }
    return [flag, FLAG_DESCRIPTIONS[flag] || "QC flag.", values.filter(Boolean).join("; ")]
      .filter(Boolean)
      .join("\n");
  }

  window.SurfaceLabCmcWorkflow = {
    PRESETS,
    fileIdentity,
    fileKey,
    appendFileRows,
    presetOptions,
    reviewCacheKey,
    dropletKey,
    applyUsedOverrides,
    sortRowsByConcentration,
    flagLabel,
    flagTitle,
  };
})();
