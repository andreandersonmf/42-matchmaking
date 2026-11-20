import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

/**
 * As imagens de /profile, /ranking e do resultado são desenhadas em SVG e convertidas em PNG.
 * Servidores Linux (como a Discloud) não trazem fontes instaladas, então qualquer texto virava
 * quadradinhos. Aqui a fonte Inter vai junto com o projeto (pasta assets/fonts) e é carregada
 * direto dos arquivos, sem depender de nada instalado no sistema operacional.
 */
export const FONT_FAMILY = 'Inter';
export const FONT_STACK = `${FONT_FAMILY}, sans-serif`;

const FONT_WEIGHTS = [400, 600, 700, 800] as const;
const fontDirectory = new URL('../../assets/fonts/', import.meta.url);

export function fontFiles(): string[] {
  return FONT_WEIGHTS.map(weight => fileURLToPath(new URL(`Inter-${weight}.ttf`, fontDirectory)));
}

export function assertFontsAvailable(): void {
  const missing = fontFiles().filter(file => !existsSync(file));
  if (missing.length) {
    throw new Error('Fontes das imagens não encontradas. Envie a pasta assets/fonts junto com o bot (veja o zip:discloud).');
  }
}

/** Mantém apenas caracteres que a fonte embutida sabe desenhar (latim, acentos e pontuação comum). */
export function drawable(value: string): string {
  const cleaned = value.replace(/[^\u0020-\u007e\u00a0-\u024f\u2010-\u2027\u2030-\u205e]/gu, '').replace(/\s+/g, ' ').trim();
  return cleaned;
}

export function svgToPng(svg: string): Buffer {
  assertFontsAvailable();
  const resvg = new Resvg(svg, {
    font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
    fitTo: { mode: 'original' },
  });
  return resvg.render().asPng();
}
