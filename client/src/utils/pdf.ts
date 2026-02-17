/**
 * PDF ユーティリティ
 * 
 * pdfjs-dist を使って PDF ページを画像化
 */

import * as pdfjsLib from 'pdfjs-dist';

// Worker の設定
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// PDF ドキュメントキャッシュ
const pdfDocCache = new Map<string, pdfjsLib.PDFDocumentProxy>();

/**
 * PDF を読み込む
 */
export async function loadPdfDocument(dataUrl: string): Promise<pdfjsLib.PDFDocumentProxy> {
  // キャッシュをチェック
  if (pdfDocCache.has(dataUrl)) {
    return pdfDocCache.get(dataUrl)!;
  }
  
  // Base64 データを ArrayBuffer に変換
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdfDoc = await loadingTask.promise;
  
  // キャッシュに保存
  pdfDocCache.set(dataUrl, pdfDoc);
  
  return pdfDoc;
}

/**
 * PDF ページを Canvas に描画して ImageData を取得
 */
export async function renderPdfPage(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale: number = 1.5
): Promise<HTMLImageElement> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  
  // オフスクリーン Canvas を作成
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  
  // PDF ページを描画
  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
  }).promise;
  
  // Canvas を画像に変換
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * PDF ページ数を取得
 */
export function getPdfPageCount(pdfDoc: pdfjsLib.PDFDocumentProxy): number {
  return pdfDoc.numPages;
}

/**
 * PDF の最初のページを画像として取得
 */
export async function getPdfFirstPageAsImage(dataUrl: string): Promise<HTMLImageElement> {
  const pdfDoc = await loadPdfDocument(dataUrl);
  return renderPdfPage(pdfDoc, 1);
}
