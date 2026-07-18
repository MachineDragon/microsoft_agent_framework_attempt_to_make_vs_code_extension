type VscodeApi = {
  postMessage: (message: unknown) => void;
};

type BudAIResponse<T> = {
  type: 'budai.response';
  requestId: string;
  ok: boolean;
  result?: T;
  error?: string;
};

declare global {
  interface Window {
    acquireVsCodeApi?: () => VscodeApi;
  }
}

let vscodeApi: VscodeApi | null | undefined;
let requestCounter = 0;

function getVscodeApi(): VscodeApi | null {
  if (vscodeApi !== undefined) return vscodeApi;
  if (typeof window === 'undefined' || typeof window.acquireVsCodeApi !== 'function') {
    vscodeApi = null;
    return vscodeApi;
  }
  vscodeApi = window.acquireVsCodeApi();
  return vscodeApi;
}

export function isVscodeBridgeAvailable(): boolean {
  return getVscodeApi() !== null;
}

export function requestVscode<T>(command: string, payload?: unknown, timeoutMs = 10000): Promise<T> {
  const api = getVscodeApi();
  if (!api) {
    return Promise.reject(new Error('VS Code bridge is not available.'));
  }

  const requestId = `budai-${Date.now()}-${requestCounter++}`;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', handleMessage);
      reject(new Error(`Timed out waiting for VS Code response to ${command}.`));
    }, timeoutMs);

    const handleMessage = (event: MessageEvent) => {
      const response = event.data as Partial<BudAIResponse<T>>;
      if (response?.type !== 'budai.response' || response.requestId !== requestId) {
        return;
      }

      window.clearTimeout(timeout);
      window.removeEventListener('message', handleMessage);
      if (response.ok) {
        resolve(response.result as T);
      } else {
        reject(new Error(response.error || `VS Code request failed: ${command}`));
      }
    };

    window.addEventListener('message', handleMessage);
    api.postMessage({ type: 'budai.request', requestId, command, payload });
  });
}