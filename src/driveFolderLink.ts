// Users naturally paste a Drive folder URL copied from the browser address bar into a manual
// folder-ID field rather than the bare ID. Stored verbatim, that URL becomes an invalid `parents[]`
// value and every upload fails with a confusing non-permission error — so not even the folder-write
// root fallback (which only fires on `insufficientFilePermissions` 403s) kicks in. Extract the ID
// from the common Drive folder-URL shapes; pass a bare ID — or anything we don't recognize — through
// unchanged so the field still accepts a raw folder ID.
export function normalizeDriveFolderId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  // https://drive.google.com/drive/folders/<ID>  (also /drive/u/0/folders/<ID>, optional ?usp=…)
  const folderMatch = value.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (folderMatch) {
    return folderMatch[1];
  }
  // https://drive.google.com/open?id=<ID>  (or any …?id=/&id= form)
  const idParamMatch = value.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idParamMatch) {
    return idParamMatch[1];
  }
  return value;
}
