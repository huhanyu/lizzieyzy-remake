export const percent = (v: number | undefined) =>
  v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;
