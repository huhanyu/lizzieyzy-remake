export const boardThemes = [
  { id: "classic", name: "经典", color: "#d9b77d", line: "#604a2d", background: "#dce2de", scale: 1 },
  { id: "baduktv", name: "BadukTV", color: "#d7b579", line: "#3c392f", background: "#343b3e", scale: 1.28 },
  { id: "photorealistic", name: "Photorealistic · 写实", color: "#d9b77d", line: "#222", background: "#343b32", scale: 1 },
  { id: "subdued", name: "Subdued · 柔和", color: "#d2ac76", line: "#332c22", background: "#252525", scale: 1 }
] as const;
export type BoardThemeId = typeof boardThemes[number]["id"];
const key = "lizzieyzy.board-theme.v1";
export function loadBoardTheme(): BoardThemeId {
  try { const saved = localStorage.getItem(key); return boardThemes.find(theme => theme.id === saved)?.id ?? "classic"; }
  catch { return "classic"; }
}
export function saveBoardTheme(id: BoardThemeId) {
  try { localStorage.setItem(key, id); return true; } catch { return false; }
}
export type BoardThemeImages = { board: HTMLImageElement; black: HTMLImageElement; white: HTMLImageElement };
const cache = new Map<string, Promise<BoardThemeImages>>();
export function loadBoardThemeImages(id: BoardThemeId): Promise<BoardThemeImages> {
  const existing = cache.get(id); if (existing) return existing;
  const image = (name: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("主题图片加载失败"));
    img.src = `/themes/${id}/${name}.png`;
  });
  const promise = Promise.all([image("board"), image("black"), image("white")]).then(([board, black, white]) => ({board, black, white}));
  cache.set(id, promise); promise.catch(() => cache.delete(id)); return promise;
}
