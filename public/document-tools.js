/* Called by the document selection UI; selections must be two document IDs. */
window.documentTools = {
  originalUrl(id) {
    return `/api/documents/${encodeURIComponent(id)}/original`;
  },
  async compare(documentIds) {
    return api("documents/compare-full", { documentIds });
  },
  async downloadRedline(documentIds) {
    const response = await fetch("/api/documents/redline.docx", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": authState?.csrf || "",
      },
      body: JSON.stringify({ documentIds }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw Error(result.error || "Export failed.");
    }
    const url = URL.createObjectURL(await response.blob()),
      link = document.createElement("a");
    link.href = url;
    link.download = "tracked-changes.docx";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
