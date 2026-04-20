(function () {
  function downloadBytes(filename, bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function downloadText(filename, text, mimeType) {
    downloadBytes(
      filename,
      new TextEncoder().encode(text),
      mimeType || "text/plain;charset=utf-8"
    );
  }

  window.SurfaceLabDownloads = {
    downloadBytes,
    downloadText,
  };
})();
