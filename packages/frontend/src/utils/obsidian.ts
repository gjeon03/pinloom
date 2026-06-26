// Open a directory as an Obsidian vault. `obsidian://` is a registered OS
// protocol; clicking a transient anchor hands the URI to the handler without
// navigating the app away (which `location.href = …` would attempt). The folder
// must already be added to Obsidian once ("Open folder as vault") — there is no
// URI to register an arbitrary path, so the buttons carry that one-time hint.
export function openInObsidian(absDir: string): void {
  const a = document.createElement('a');
  a.href = `obsidian://open?path=${encodeURIComponent(absDir)}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
