import { parseUnifiedDiff } from "./diff-view-model.js";
import { CONTEXT_QUERY_KEYS, REVIEW_ROUTES } from "./review-protocol.js";

export function renderReviewPage(input: { diff: string; target: string; targetLabel: string; cwd: string; submitEnabled: boolean }): string {
	const files = parseUnifiedDiff(input.diff);
	const encodedFiles = JSON.stringify(files).replace(/</g, "\\u003c");
	const encodedRoutes = JSON.stringify(REVIEW_ROUTES).replace(/</g, "\\u003c");
	const encodedContextQueryKeys = JSON.stringify(CONTEXT_QUERY_KEYS).replace(/</g, "\\u003c");
	const emptyState = files.length === 0
		? `<div class="empty">No diff output for <code>${escapeHtml(input.targetLabel)}</code>.</div>`
		: "";

	return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi Web Review</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <style>
    :root {
      --bg: #f6f8fa;
      --card: #fff;
      --border: #d0d7de;
      --muted: #57606a;
      --text: #1f2328;
      --blue: #0969da;
      --green-bg: #e6ffec;
      --red-bg: #ffebe9;
      --hunk-bg: #ddf4ff;
      --gap-bg: #f6f8fa;
      --comment-header-bg: #f6f8fa;
      --comment-body-bg: #fff;
      --comment-text: #1f2328;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: var(--bg);
      font-family: monospace;
      font-size: 14px;
    }
    code, pre, .diff, .line-code, .line-number, textarea {
      font-family: monospace;
    }
    .page {
      max-width: 1600px;
      margin: 0 auto;
      padding: 16px;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      margin-bottom: 12px;
      padding: 12px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(8px);
    }
    h1 {
      margin: 0;
      font-size: 18px;
    }
    .meta {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn {
      border: 1px solid rgba(31, 35, 40, 0.15);
      border-radius: 6px;
      background: #f6f8fa;
      color: var(--text);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 12px;
    }
    .btn:hover { background: #eef1f4; }
    .btn-primary {
      background: #1a7f37;
      color: #fff;
    }
    .btn-primary:hover { background: #197935; }
    .btn-danger {
      background: #fff;
      color: #cf222e;
      border-color: #cf222e;
    }
    .file {
      overflow: hidden;
      margin-bottom: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
    }
    .file-header {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      background: #f6f8fa;
      font-weight: 600;
    }
    table.diff {
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      table-layout: fixed;
    }
    table.diff,
    table.diff tbody,
    table.diff tr,
    table.diff td {
      border: 0;
    }
    col.line-no { width: 56px; }
    col.code { width: calc(50% - 56px); }

    tr.hunk-header td {
      padding: 4px 10px;
      background: var(--hunk-bg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      color: #0550ae;
      font-size: 12px;
    }

    tr.diff-row td { border-bottom: 0; vertical-align: top; }
    td.line-number {
      position: relative;
      color: var(--muted);
      text-align: right;
      user-select: none;
      padding: 2px 8px;
      background: transparent;
      white-space: nowrap;
    }
    td.line-code {
      padding: 2px 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
      background: transparent;
    }
    td.line-number.empty,
    td.line-code.empty {
      background: #f6f8fa;
    }

    td.line-number.added,
    td.line-code.added { background: var(--green-bg); }
    td.line-number.removed,
    td.line-code.removed { background: var(--red-bg); }

    .line-prefix {
      display: inline-block;
      width: 14px;
      color: var(--muted);
      user-select: none;
      margin-right: 2px;
    }

    .comment-trigger {
      display: none;
      position: absolute;
      left: 4px;
      top: 50%;
      width: 16px;
      height: 16px;
      transform: translateY(-50%);
      border: 1px solid #1f6feb;
      border-radius: 999px;
      background: #2f81f7;
      color: #fff;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      line-height: 14px;
      padding: 0;
      text-align: center;
    }
    td.line-number:hover .comment-trigger,
    .comment-trigger:focus-visible {
      display: inline-block;
    }

    .review-comment {
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: var(--comment-body-bg);
    }
    .review-comment-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--comment-header-bg);
      color: var(--muted);
      font-size: 12px;
    }
    .review-comment-author {
      color: var(--text);
      font-weight: 600;
    }
    .review-comment-actions {
      display: flex;
      gap: 6px;
      margin-left: auto;
    }
    .review-comment-btn {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--blue);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: 4px 6px;
    }
    .review-comment-btn.delete { color: #cf222e; }
    .review-comment-body {
      padding: 8px;
      color: var(--comment-text);
      font-size: 13px;
      white-space: pre-wrap;
    }

    tr.comment-row td {
      padding: 8px;
      border-top: 1px solid #d4a72c;
      border-bottom: 1px solid #d4a72c;
      vertical-align: top;
    }
    tr.comment-row td.comment-fill {
      background: #f6f8fa;
    }
    tr.comment-row td.comment-cell {
      background: #fff8c5;
    }
    .comment-box {
      width: 100%;
      border: 1px solid #d4a72c;
      border-radius: 6px;
      background: #fff;
      padding: 8px;
    }
    .comment-box textarea {
      width: 100%;
      min-height: 76px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px;
      font: inherit;
      font-size: 13px;
    }
    .comment-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    tr.gap-row td {
      background: var(--gap-bg);
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      text-align: center;
      padding: 6px;
    }
    .gap-btn {
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      color: var(--blue);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
    }
    .gap-btn[disabled] { opacity: 0.7; cursor: default; }

    .empty {
      padding: 32px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--card);
      color: var(--muted);
      text-align: center;
    }

    .code-content,
    .code-content.hljs,
    .code-content.hljs * {
      display: inline;
      padding: 0;
      background: transparent;
      font-family: inherit;
    }

    @media (max-width: 900px) {
      .toolbar { align-items: flex-start; flex-direction: column; }
      .actions { justify-content: flex-start; }
      col.line-no { width: 46px; }
      col.code { width: calc(50% - 46px); }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="toolbar">
      <div>
        <h1>Changes since ${escapeHtml(input.targetLabel)}</h1>
        <div class="meta">${escapeHtml(input.cwd)} · diff target <code>${escapeHtml(input.target)}</code> (resolved from <code>${escapeHtml(input.targetLabel)}</code>)</div>
      </div>
      <div class="actions">
        <button class="btn" id="reload">Reload diff</button>
        <button class="btn btn-danger" id="close">Close review</button>
        <button class="btn btn-primary" id="submit">${input.submitEnabled ? "Send comments" : "Log comments"}</button>
      </div>
    </div>
    ${emptyState}
    <div id="diff-root"></div>
  </div>
  <script>
    const files = ${encodedFiles};
    const comments = new Map();
    const routes = ${encodedRoutes};
    const contextQueryKeys = ${encodedContextQueryKeys};
    let openEditorKey = null;

    function escapeHtml(input) {
      return String(input || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function rowKey(file, side, line) {
      return file + "::" + side + "::" + line;
    }

    function closeEditor() {
      const existing = document.querySelector("tr.comment-row");
      if (existing) existing.remove();
      openEditorKey = null;
    }

    const preferredLanguages = [
      "bash", "c", "cpp", "csharp", "css", "diff", "go", "graphql", "hcl", "html", "ini",
      "java", "javascript", "json", "kotlin", "lua", "makefile", "markdown", "objectivec",
      "perl", "php", "python", "r", "ruby", "rust", "scala", "shell", "sql", "swift",
      "toml", "typescript", "xml", "yaml"
    ];

    function getHighlightLanguages() {
      if (!window.hljs || typeof window.hljs.getLanguage !== "function") return undefined;
      return preferredLanguages.filter((lang) => window.hljs.getLanguage(lang));
    }

    function applySyntaxHighlighting() {
      if (!window.hljs) return;
      const languages = getHighlightLanguages();
      document.querySelectorAll("code.code-content").forEach((node) => {
        try {
          const text = node.textContent || "";
          const result = languages && languages.length > 0
            ? window.hljs.highlightAuto(text, languages)
            : window.hljs.highlightAuto(text);
          node.innerHTML = result.value;
          node.classList.add("hljs");
        } catch {}
      });
    }

    function makeSide(kind, line, content) {
      return { kind, line, content };
    }

    function buildSplitRows(hunk) {
      const rows = [];
      const lines = hunk.lines || [];
      let i = 0;
      while (i < lines.length) {
        const current = lines[i];

        if (current.type === "removed") {
          const removed = [];
          while (i < lines.length && lines[i].type === "removed") removed.push(lines[i++]);
          const added = [];
          while (i < lines.length && lines[i].type === "added") added.push(lines[i++]);
          const maxRows = Math.max(removed.length, added.length);
          for (let idx = 0; idx < maxRows; idx++) {
            const left = removed[idx] ? makeSide("removed", removed[idx].oldLine, removed[idx].content) : null;
            const right = added[idx] ? makeSide("added", added[idx].newLine, added[idx].content) : null;
            rows.push({ type: "diff", rowKind: added.length > 0 ? "changed" : "removed", left, right });
          }
          continue;
        }

        if (current.type === "added") {
          const added = [];
          while (i < lines.length && lines[i].type === "added") added.push(lines[i++]);
          for (const line of added) {
            rows.push({
              type: "diff",
              rowKind: "added",
              left: null,
              right: makeSide("added", line.newLine, line.content),
            });
          }
          continue;
        }

        rows.push({
          type: "diff",
          rowKind: "context",
          left: makeSide("context", current.oldLine, current.content),
          right: makeSide("context", current.newLine, current.content),
        });
        i++;
      }
      return rows;
    }

    function renderComment(comment, key) {
      if (!comment) return "";
      return '<div class="review-comment" data-comment-key="' + escapeHtml(key) + '">' +
        '<div class="review-comment-header">' +
          '<span><span class="review-comment-author">You</span> commented</span>' +
          '<div class="review-comment-actions">' +
            '<button class="review-comment-btn edit" type="button" data-action="edit-comment" data-key="' + escapeHtml(key) + '">Edit</button>' +
            '<button class="review-comment-btn delete" type="button" data-action="delete-comment" data-key="' + escapeHtml(key) + '">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="review-comment-body">' + escapeHtml(comment.comment) + '</div>' +
      '</div>';
    }

    function renderSideCells(filePath, side, data) {
      if (!data) {
        return '<td class="line-number empty"></td><td class="line-code empty"></td>';
      }

      const line = String(data.line || "");
      const key = rowKey(filePath, side, line);
      const comment = comments.get(key);
      const marker = data.kind === "added" ? "+" : data.kind === "removed" ? "-" : " ";

      return '<td class="line-number ' + data.kind + '">' +
          '<button class="comment-trigger" type="button" title="Add comment" aria-label="Add comment" data-file="' + escapeHtml(filePath) + '" data-side="' + side + '" data-line="' + escapeHtml(line) + '">+</button>' +
          escapeHtml(line) +
        '</td>' +
        '<td class="line-code ' + data.kind + '">' +
          '<span class="line-prefix">' + marker + '</span><code class="code-content">' + escapeHtml(data.content || "") + '</code>' +
          renderComment(comment, key) +
        '</td>';
    }

    function renderDiffRow(filePath, row, rowId) {
      if (row.type === "hunk") {
        return '<tr class="hunk-header" data-row-id="' + rowId + '"><td colspan="4">' + escapeHtml(row.header) + '</td></tr>';
      }
      if (row.type === "gap") {
        return '<tr class="gap-row" data-row-id="' + rowId + '" data-file="' + escapeHtml(filePath) + '" data-old-start="' + row.oldStart + '" data-old-end="' + row.oldEnd + '" data-new-start="' + row.newStart + '" data-new-end="' + row.newEnd + '" data-hidden="' + row.hidden + '">' +
          '<td colspan="4"><button class="gap-btn" type="button" data-action="expand-gap">Show ' + row.hidden + ' hidden lines</button></td>' +
        '</tr>';
      }

      return '<tr class="diff-row ' + row.rowKind + '" data-row-id="' + rowId + '">' +
        renderSideCells(filePath, "old", row.left) +
        renderSideCells(filePath, "new", row.right) +
      '</tr>';
    }

    function collapseContextRows(rows, filePath) {
      const collapsed = [];
      const keepEdge = 3;
      const collapseThreshold = keepEdge * 2 + 1;
      let i = 0;

      while (i < rows.length) {
        const row = rows[i];
        if (row.rowKind !== "context") {
          collapsed.push(row);
          i++;
          continue;
        }

        const runStart = i;
        while (i < rows.length && rows[i].rowKind === "context") i++;
        const run = rows.slice(runStart, i);

        if (run.length < collapseThreshold) {
          collapsed.push(...run);
          continue;
        }

        const left = run[keepEdge];
        const right = run[run.length - keepEdge - 1];
        const oldStart = left?.left?.line || 0;
        const oldEnd = right?.left?.line || 0;
        const newStart = left?.right?.line || 0;
        const newEnd = right?.right?.line || 0;
        const hidden = run.length - keepEdge * 2;

        collapsed.push(...run.slice(0, keepEdge));
        collapsed.push({
          type: "gap",
          file: filePath,
          oldStart,
          oldEnd,
          newStart,
          newEnd,
          hidden,
        });
        collapsed.push(...run.slice(run.length - keepEdge));
      }

      return collapsed;
    }

    function buildRowsForFile(file) {
      const rows = [];
      for (let idx = 0; idx < file.hunks.length; idx++) {
        const hunk = file.hunks[idx];
        rows.push({ type: "hunk", header: hunk.header });
        rows.push(...collapseContextRows(buildSplitRows(hunk), file.path));

        const nextHunk = file.hunks[idx + 1];
        if (nextHunk) {
          const oldStart = hunk.oldStart + hunk.oldCount;
          const oldEnd = nextHunk.oldStart - 1;
          const newStart = hunk.newStart + hunk.newCount;
          const newEnd = nextHunk.newStart - 1;
          const hiddenOld = oldEnd >= oldStart ? (oldEnd - oldStart + 1) : 0;
          const hiddenNew = newEnd >= newStart ? (newEnd - newStart + 1) : 0;
          const hidden = Math.max(hiddenOld, hiddenNew);
          if (hidden > 0) {
            rows.push({ type: "gap", file: file.path, oldStart, oldEnd, newStart, newEnd, hidden });
          }
        }
      }
      return rows;
    }

    function renderDiff() {
      const root = document.getElementById("diff-root");
      root.innerHTML = files.map((file) => {
        const rows = buildRowsForFile(file);
        const rowHtml = rows.map((row, rowIdx) => renderDiffRow(file.path, row, rowIdx)).join("");

        return '<section class="file">' +
          '<div class="file-header">' + escapeHtml(file.path) + '</div>' +
          '<table class="diff">' +
            '<colgroup><col class="line-no" /><col class="code" /><col class="line-no" /><col class="code" /></colgroup>' +
            '<tbody>' + rowHtml + '</tbody>' +
          '</table>' +
        '</section>';
      }).join("");

      applySyntaxHighlighting();
    }

    function openEditorAt(row, file, side, line) {
      closeEditor();
      if (!file || !side || !line) return;
      const key = rowKey(file, side, line);
      openEditorKey = key;
      const existing = comments.get(key);
      const editor = document.createElement("tr");
      editor.className = "comment-row";

      const commentBoxHtml = '<div class="comment-box">' +
        '<div class="meta">' + escapeHtml(file) + ' · ' + side + ' line ' + escapeHtml(line) + '</div>' +
        '<textarea id="comment-input" placeholder="Leave a review comment"></textarea>' +
        '<div class="comment-actions">' +
          '<button class="btn" id="cancel-comment">Cancel</button>' +
          '<button class="btn btn-primary" id="save-comment">Save comment</button>' +
        '</div>' +
      '</div>';

      if (side === "old") {
        editor.innerHTML =
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-cell">' + commentBoxHtml + '</td>' +
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-fill"></td>';
      } else {
        editor.innerHTML =
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-fill"></td>' +
          '<td class="line-number comment-fill"></td>' +
          '<td class="line-code comment-cell">' + commentBoxHtml + '</td>';
      }

      row.parentNode.insertBefore(editor, row.nextSibling);

      const input = document.getElementById("comment-input");
      input.value = existing ? existing.comment : "";
      input.focus();
      document.getElementById("cancel-comment").onclick = closeEditor;
      document.getElementById("save-comment").onclick = () => {
        const text = input.value.trim();
        if (!text) return;
        comments.set(key, { file, side, line, comment: text });
        closeEditor();
        renderDiff();
      };
    }

    function openEditorFromTrigger(triggerButton) {
      const file = triggerButton.getAttribute("data-file");
      const side = triggerButton.getAttribute("data-side");
      const line = triggerButton.getAttribute("data-line");
      const row = triggerButton.closest("tr");
      if (!row || !file || !side || !line) return;
      openEditorAt(row, file, side, line);
    }

    function getGapRowData(row) {
      return {
        file: row.getAttribute("data-file") || "",
        oldStart: row.getAttribute("data-old-start") || "0",
        oldEnd: row.getAttribute("data-old-end") || "0",
        newStart: row.getAttribute("data-new-start") || "0",
        newEnd: row.getAttribute("data-new-end") || "0",
        hidden: row.getAttribute("data-hidden") || "0",
      };
    }

    function renderGapRowHtml(data, action, label, expandedGroup) {
      const className = expandedGroup ? "gap-row expanded-row" : "gap-row";
      const groupAttr = expandedGroup ? ' data-expanded-group="' + escapeHtml(expandedGroup) + '"' : "";
      return '<tr class="' + className + '"' + groupAttr +
        ' data-file="' + escapeHtml(data.file) + '"' +
        ' data-old-start="' + data.oldStart + '"' +
        ' data-old-end="' + data.oldEnd + '"' +
        ' data-new-start="' + data.newStart + '"' +
        ' data-new-end="' + data.newEnd + '"' +
        ' data-hidden="' + data.hidden + '">' +
        '<td colspan="4"><button class="gap-btn" type="button" data-action="' + action + '">' + label + '</button></td>' +
      '</tr>';
    }

    async function expandGapRow(row) {
      const button = row.querySelector("button.gap-btn");
      if (!button) return;

      const data = getGapRowData(row);
      if (!data.file) return;
      const params = new URLSearchParams();
      params.set(contextQueryKeys.file, data.file);
      params.set(contextQueryKeys.oldStart, data.oldStart);
      params.set(contextQueryKeys.oldEnd, data.oldEnd);
      params.set(contextQueryKeys.newStart, data.newStart);
      params.set(contextQueryKeys.newEnd, data.newEnd);

      button.disabled = true;
      button.textContent = "Loading context…";

      try {
        const res = await fetch(routes.context + "?" + params.toString());
        if (!res.ok) throw new Error("Failed to load context");
        const payload = await res.json();
        const contextRows = Array.isArray(payload.rows) ? payload.rows : [];
        const groupId = "gap-" + Math.random().toString(36).slice(2);

        const rowsHtml = contextRows.map((ctx, idx) => {
          const split = {
            type: "diff",
            rowKind: "context",
            left: ctx.oldLine ? makeSide("context", ctx.oldLine, ctx.oldContent || "") : null,
            right: ctx.newLine ? makeSide("context", ctx.newLine, ctx.newContent || "") : null,
          };
          return renderDiffRow(data.file, split, "expanded-" + idx)
            .replace('<tr class="diff-row ', '<tr class="diff-row expanded-row ')
            .replace('" data-row-id=', '" data-expanded-group="' + groupId + '" data-row-id=');
        }).join("");

        const collapseHtml = renderGapRowHtml(data, "collapse-gap", "Collapse hidden lines", groupId);

        row.insertAdjacentHTML("beforebegin", rowsHtml + collapseHtml);
        row.remove();
        applySyntaxHighlighting();
      } catch {
        button.disabled = false;
        button.textContent = "Failed to load context";
      }
    }

    function collapseGapRow(row) {
      const groupId = row.getAttribute("data-expanded-group");
      if (!groupId) return;

      const data = getGapRowData(row);
      const restored = renderGapRowHtml(data, "expand-gap", "Show " + data.hidden + " hidden lines");

      row.insertAdjacentHTML("beforebegin", restored);
      document.querySelectorAll('tr[data-expanded-group="' + CSS.escape(groupId) + '"]').forEach((node) => node.remove());
    }

    async function submitComments() {
      const payload = Array.from(comments.values());
      if (payload.length === 0) {
        alert("No comments to submit.");
        return;
      }
      const res = await fetch(routes.submit, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = "Failed to submit comments.";
        try {
          const json = await res.json();
          if (json && typeof json.error === "string" && json.error.trim()) message = json.error;
        } catch {}
        alert(message);
        return;
      }
      document.body.innerHTML = "<h2 style='text-align:center; margin-top:50px;'>Review submitted. You can close this tab.</h2>";
    }

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (target.classList.contains("comment-trigger")) {
        openEditorFromTrigger(target);
        return;
      }

      const action = target.getAttribute("data-action");
      if (action === "expand-gap") {
        const gapRow = target.closest("tr.gap-row");
        if (gapRow) void expandGapRow(gapRow);
        return;
      }

      if (action === "collapse-gap") {
        const gapRow = target.closest("tr.gap-row");
        if (gapRow) collapseGapRow(gapRow);
        return;
      }

      const key = target.getAttribute("data-key");
      if (!action || !key) return;

      if (action === "edit-comment") {
        const [file, side, line] = key.split("::");
        if (!file || !side || !line) return;
        const selector = '.comment-trigger[data-file="' + CSS.escape(file) + '"][data-side="' + CSS.escape(side) + '"][data-line="' + CSS.escape(line) + '"]';
        const trigger = document.querySelector(selector);
        if (trigger) openEditorFromTrigger(trigger);
        return;
      }

      if (action === "delete-comment") {
        comments.delete(key);
        if (openEditorKey === key) closeEditor();
        renderDiff();
      }
    });

    document.getElementById("reload").onclick = () => window.location.reload();
    document.getElementById("submit").onclick = () => void submitComments();
    document.getElementById("close").onclick = async () => {
      try { await fetch(routes.close, { method: "POST" }); } catch {}
      document.body.innerHTML = "<h2 style='text-align:center; margin-top:50px;'>Review closed. You can close this tab.</h2>";
    };

    renderDiff();
  </script>
</body>
</html>`;
}


function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}
