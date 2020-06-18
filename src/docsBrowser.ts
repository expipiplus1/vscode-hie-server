import { dirname } from 'path';
import {
  CancellationToken,
  commands,
  Disposable,
  Hover,
  MarkdownString,
  MarkedString,
  Position,
  ProviderResult,
  TextDocument,
  Uri,
  ViewColumn,
  window,
} from 'vscode';
import { ProvideHoverSignature } from 'vscode-languageclient';

export namespace DocsBrowser {
  'use strict';

  // registers the browser in VSCode infrastructure
  export function registerDocsBrowser(): Disposable {
    return commands.registerCommand('haskell.showDocumentation', ({ title, path }: { title: string; path: string }) => {
      const arr = path.match(/([^\/]+)\.[^.]+$/);
      const ttl = arr !== null && arr.length === 2 ? arr[1].replace(/-/gi, '.') : title;
      const documentationDirectory = dirname(path);
      let panel;
      try {
        // Make sure to use Uri.parse here, as path will already have 'file:///' in it
        panel = window.createWebviewPanel('haskell.showDocumentationPanel', ttl, ViewColumn.Beside, {
          localResourceRoots: [Uri.parse(documentationDirectory)],
          enableFindWidget: true,
        });
        const uri = panel.webview.asWebviewUri(Uri.parse(path));
        panel.webview.html = `<iframe src="${uri}" frameBorder = "0" style = "background: white; width: 100%; height: 100%; position:absolute; left: 0; right: 0; bottom: 0; top: 0px;" /> `;
      } catch (e) {
        window.showErrorMessage(e);
      }
      return panel;
    });
  }

  export function hoverLinksMiddlewareHook(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
    next: ProvideHoverSignature
  ): ProviderResult<Hover> {
    const res = next(document, position, token);
    return Promise.resolve(res).then((r) => {
      if (r !== null && r !== undefined) {
        r.contents = r.contents.map(processLink);
      }
      return r;
    });
  }

  function processLink(ms: MarkedString): MarkedString {
    function transform(s: string): string {
      return s.replace(/\[(.+)\]\((file:.+\/doc\/.+\.html#?.*)\)/gi, (all, title, path) => {
        const encoded = encodeURIComponent(JSON.stringify({ title, path }));
        const cmd = 'command:haskell.showDocumentation?' + encoded;
        return `[${title}](${cmd})`;
      });
    }
    if (typeof ms === 'string') {
      const mstr = new MarkdownString(transform(ms));
      mstr.isTrusted = true;
      return mstr;
    } else if (ms instanceof MarkdownString) {
      const mstr = new MarkdownString(transform(ms.value));
      mstr.isTrusted = true;
      return mstr;
    } else {
      return ms;
    }
  }
}
