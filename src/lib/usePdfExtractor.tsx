import { useCallback, useRef, type ReactElement } from "react";
import { View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { PDFJS_PAGE_HTML } from "@/data/pdfjs-page";
import type { PdfItem } from "./pdfRouteList";

// Reads the text of a PDF with pdf.js inside a hidden WebView (the bundled page
// in src/data/pdfjs-page.ts). Render `view` once on the screen, then call
// `extract(base64)`. Rejects with a readable message on any failure.

const TIMEOUT_MS = 45_000;

type Pending = {
  resolve: (items: PdfItem[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function usePdfExtractor(): { view: ReactElement; extract: (base64: string) => Promise<PdfItem[]> } {
  const webRef = useRef<WebView>(null);
  const pageReady = useRef(false);
  const whenReady = useRef<(() => void)[]>([]);
  const pending = useRef<Pending | null>(null);

  const settle = useCallback((fn: (p: Pending) => void) => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    fn(p);
  }, []);

  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let msg: { type?: string; items?: PdfItem[]; message?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      settle((p) => p.reject(new Error("The PDF reader sent back something unreadable.")));
      return;
    }
    if (msg.type === "ready") {
      pageReady.current = true;
      whenReady.current.splice(0).forEach((send) => send());
    } else if (msg.type === "items" && Array.isArray(msg.items)) {
      const items = msg.items;
      settle((p) => p.resolve(items));
    } else if (msg.type === "error") {
      settle((p) => p.reject(new Error(`Couldn't read this PDF: ${msg.message ?? "unknown error"}`)));
    }
  }, [settle]);

  const onLoadError = useCallback(() => {
    settle((p) => p.reject(new Error("The PDF reader failed to load.")));
  }, [settle]);

  const extract = useCallback((base64: string) => new Promise<PdfItem[]>((resolve, reject) => {
    if (pending.current) {
      reject(new Error("A PDF is already being read."));
      return;
    }
    const timer = setTimeout(() => {
      pending.current = null;
      reject(new Error("Reading the PDF took too long."));
    }, TIMEOUT_MS);
    pending.current = { resolve, reject, timer };
    const send = () => webRef.current?.injectJavaScript(`window.extractPdf(${JSON.stringify(base64)}); true;`);
    if (pageReady.current) send();
    else whenReady.current.push(send);
  }), []);

  const view = (
    <View pointerEvents="none" style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}>
      <WebView
        ref={webRef}
        originWhitelist={["*"]}
        source={{ html: PDFJS_PAGE_HTML }}
        javaScriptEnabled
        onMessage={onMessage}
        onError={onLoadError}
        onHttpError={onLoadError}
      />
    </View>
  );

  return { view, extract };
}
