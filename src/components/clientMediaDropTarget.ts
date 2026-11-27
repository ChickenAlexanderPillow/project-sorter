export function mediaDropTarget(x: number, y: number) {
  const element = document.elementFromPoint(x, y);
  const row = element?.closest<HTMLElement>(".droppable-row[data-client]");
  const candidate = element?.closest<HTMLElement>("[data-media-drop-folder]");
  const folder = row && !row.classList.contains("client-row-transfer-active")
    && candidate?.closest(".droppable-row") === row
    && candidate.closest<HTMLElement>(".client-media-drop")?.dataset.visible === "true" ? candidate : null;
  const highlighted = document.querySelector("[data-media-drop-hover]");
  if (highlighted !== folder) {
    highlighted?.removeAttribute("data-media-drop-hover");
    folder?.setAttribute("data-media-drop-hover", "true");
  }
  const mixed = Boolean(row && !row.classList.contains("client-row-transfer-active") && row.querySelector(':scope > .client-media-drop[data-mixed="true"][data-visible="true"]'));
  return { client: row?.dataset.client, folder: folder?.dataset.mediaDropFolder, mixed };
}
