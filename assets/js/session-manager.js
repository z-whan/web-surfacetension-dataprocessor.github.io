(function (global) {
  const SCHEMA_NAME = "surface-lab-session";
  const SCHEMA_VERSION = 1;
  const MAX_ARRAY_VALUES = 200000;

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function safeString(value, fallback) {
    return typeof value === "string" ? value : fallback;
  }

  function safeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function safeNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function cloneJson(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }
    if (Array.isArray(value)) {
      return value.map((item) => cloneJson(item));
    }
    if (isPlainObject(value)) {
      const output = {};
      Object.keys(value).forEach((key) => {
        output[key] = cloneJson(value[key]);
      });
      return output;
    }
    return null;
  }

  function countArrayValues(value) {
    if (!value || typeof value !== "object") {
      return 0;
    }
    if (Array.isArray(value)) {
      return value.length + value.reduce((total, item) => total + countArrayValues(item), 0);
    }
    return Object.keys(value).reduce((total, key) => total + countArrayValues(value[key]), 0);
  }

  function sanitizeTimeSeriesState(value, warnings) {
    if (!isPlainObject(value)) {
      warnings.push("Time Series state was missing or invalid.");
      return {};
    }

    const selection = isPlainObject(value.selection) ? value.selection : {};
    const trend = isPlainObject(value.trend) ? value.trend : {};
    const noise = isPlainObject(value.noise) ? value.noise : {};
    const yAxis = isPlainObject(value.yAxis) ? value.yAxis : {};
    const file = isPlainObject(value.file) ? value.file : null;

    return {
      file: file
        ? {
            name: safeString(file.name, ""),
            size: safeNumber(file.size, null),
            type: safeString(file.type, ""),
            lastModified: safeNumber(file.lastModified, null),
          }
        : null,
      selection: {
        startText: safeString(selection.startText, ""),
        endText: safeString(selection.endText, ""),
        expRangeText: safeString(selection.expRangeText, ""),
        avgOnly: safeBoolean(selection.avgOnly, false),
        showOriginalWithAvg: safeBoolean(selection.showOriginalWithAvg, false),
      },
      trend: {
        methodKey: safeString(trend.methodKey, ""),
        parameters: cloneJson(isPlainObject(trend.parameters) ? trend.parameters : {}),
        showRaw: safeBoolean(trend.showRaw, true),
        applied: safeBoolean(trend.applied, false),
      },
      noise: {
        methodKey: safeString(noise.methodKey, ""),
        parameters: cloneJson(isPlainObject(noise.parameters) ? noise.parameters : {}),
      },
      yAxis: {
        spanPercent: safeNumber(yAxis.spanPercent, 100),
        manualRange: Array.isArray(yAxis.manualRange)
          ? yAxis.manualRange.map((item) => safeNumber(item, null)).slice(0, 2)
          : null,
        yMinText: safeString(yAxis.yMinText, ""),
        yMaxText: safeString(yAxis.yMaxText, ""),
      },
    };
  }

  function sanitizeCompareState(value, warnings) {
    if (!isPlainObject(value)) {
      warnings.push("Compare state was missing or invalid.");
      return { curves: [], selectedDisplayIndexes: [], yAxis: {} };
    }

    const curves = Array.isArray(value.curves) ? value.curves : [];
    const sanitizedCurves = curves
      .filter((curve) => isPlainObject(curve))
      .map((curve) => cloneJson(curve));
    const arrayValues = countArrayValues(sanitizedCurves);
    if (arrayValues > MAX_ARRAY_VALUES) {
      warnings.push(
        "Compare curves contain large numeric arrays; the session includes them and may be slow to import."
      );
    }

    const yAxis = isPlainObject(value.yAxis) ? value.yAxis : {};
    return {
      curves: sanitizedCurves,
      selectedDisplayIndexes: Array.isArray(value.selectedDisplayIndexes)
        ? value.selectedDisplayIndexes.map((item) => safeNumber(item, null)).filter((item) => item !== null)
        : [],
      lastPlottedDisplayIndexes: Array.isArray(value.lastPlottedDisplayIndexes)
        ? value.lastPlottedDisplayIndexes.map((item) => safeNumber(item, null)).filter((item) => item !== null)
        : [],
      yAxis: {
        spanPercent: safeNumber(yAxis.spanPercent, 100),
        manualRange: Array.isArray(yAxis.manualRange)
          ? yAxis.manualRange.map((item) => safeNumber(item, null)).slice(0, 2)
          : null,
        yMinText: safeString(yAxis.yMinText, ""),
        yMaxText: safeString(yAxis.yMaxText, ""),
      },
    };
  }

  function sanitizePublicationState(value, warnings) {
    if (!isPlainObject(value)) {
      warnings.push("Publication Plot state was missing or invalid.");
      return { data: [], layout: {}, config: {}, exportSettings: {} };
    }

    const data = cloneJson(Array.isArray(value.data) ? value.data : []);
    const arrayValues = countArrayValues(data);
    if (arrayValues > MAX_ARRAY_VALUES) {
      warnings.push(
        "Publication Plot trace data is large; the session includes it and may be slow to import."
      );
    }

    return {
      sourceType: safeString(value.sourceType, "unknown"),
      sourceTitle: safeString(value.sourceTitle, ""),
      filenameBase: safeString(value.filenameBase, "publication-plot"),
      figurePayload: cloneJson(isPlainObject(value.figurePayload) ? value.figurePayload : {}),
      data,
      layout: cloneJson(isPlainObject(value.layout) ? value.layout : {}),
      config: cloneJson(isPlainObject(value.config) ? value.config : {}),
      exportSettings: cloneJson(isPlainObject(value.exportSettings) ? value.exportSettings : {}),
      defaultLayout: cloneJson(isPlainObject(value.defaultLayout) ? value.defaultLayout : {}),
      defaultExportSettings: cloneJson(isPlainObject(value.defaultExportSettings) ? value.defaultExportSettings : {}),
      defaultTraceStyles: cloneJson(Array.isArray(value.defaultTraceStyles) ? value.defaultTraceStyles : []),
      styleMeta: cloneJson(isPlainObject(value.styleMeta) ? value.styleMeta : {}),
    };
  }

  function createSession(parts) {
    const warnings = [];
    const input = isPlainObject(parts) ? parts : {};
    const session = {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      app: "Surface Tension Analysis Tool",
      warnings,
      timeSeries: sanitizeTimeSeriesState(input.timeSeries, warnings),
      compare: sanitizeCompareState(input.compare, warnings),
      publication: sanitizePublicationState(input.publication, warnings),
    };

    if (session.timeSeries.file) {
      warnings.push(
        "Imported sessions restore Time Series settings, but the original local data file must be selected again."
      );
    }
    return session;
  }

  function parseSessionText(text) {
    try {
      return { ok: true, value: JSON.parse(text), warnings: [] };
    } catch (error) {
      return {
        ok: false,
        value: null,
        warnings: ["The selected file is not valid JSON."],
        error,
      };
    }
  }

  function validateSession(value) {
    const warnings = [];
    if (!isPlainObject(value)) {
      return { ok: false, session: null, warnings: ["Session JSON must be an object."] };
    }
    if (value.schema !== SCHEMA_NAME) {
      return { ok: false, session: null, warnings: ["Unsupported session schema."] };
    }
    if (value.schemaVersion !== SCHEMA_VERSION) {
      return {
        ok: false,
        session: null,
        warnings: [`Unsupported session schema version: ${String(value.schemaVersion)}.`],
      };
    }

    const session = {
      schema: SCHEMA_NAME,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: safeString(value.exportedAt, ""),
      app: safeString(value.app, ""),
      warnings: Array.isArray(value.warnings)
        ? value.warnings.filter((item) => typeof item === "string")
        : [],
      timeSeries: sanitizeTimeSeriesState(value.timeSeries, warnings),
      compare: sanitizeCompareState(value.compare, warnings),
      publication: sanitizePublicationState(value.publication, warnings),
    };

    return { ok: true, session, warnings };
  }

  function parseAndValidateSession(text) {
    const parsed = parseSessionText(text);
    if (!parsed.ok) {
      return { ok: false, session: null, warnings: parsed.warnings };
    }
    return validateSession(parsed.value);
  }

  global.SurfaceLabSessionManager = {
    SCHEMA_NAME,
    SCHEMA_VERSION,
    createSession,
    parseSessionText,
    validateSession,
    parseAndValidateSession,
  };
})(typeof window !== "undefined" ? window : globalThis);
