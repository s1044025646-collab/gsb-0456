export function toBinaryPGM(matrix: number[][]): Buffer {
  const height = matrix.length;
  const width = matrix[0]?.length ?? 0;
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii");
  const pixels = Buffer.alloc(width * height);
  let offset = 0;
  for (const row of matrix) {
    for (const value of row) {
      pixels[offset] = value === 255 ? 255 : 0;
      offset += 1;
    }
  }
  return Buffer.concat([header, pixels]);
}

export function toAsciiPGM(matrix: number[][]): string {
  const height = matrix.length;
  const width = matrix[0]?.length ?? 0;
  const rows = matrix.map((row) => row.join(" ")).join("\n");
  return `P2\n${width} ${height}\n255\n${rows}\n`;
}
