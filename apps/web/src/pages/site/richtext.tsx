import { isHttpsUrl, SECTION_LIMITS, type InlineText, type RichBlock } from "@gcf/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { Field, Modal } from "../../components/ui";
import { MoveButtons, moveItem } from "./common";

/**
 * Editor of the constrained rich text of the site: a list of blocks (paragraph, heading level 2 or 3, bulleted or
 * numbered list), each edited in place with bold, italic and https links. The browser's editable area is only an
 * input surface: its DOM is read back into the block structure on every change, so pasted or dropped markup never
 * reaches the page (pastes are inserted as plain text, unknown tags keep only their text).
 */

type BlockKind = "paragraph" | "h2" | "h3" | "ul" | "ol";

const KIND_LABEL: Record<BlockKind, string> = {
  paragraph: "Paragraphe",
  h2: "Titre (niveau 2)",
  h3: "Sous-titre (niveau 3)",
  ul: "Liste à puces",
  ol: "Liste numérotée",
};

const kindOf = (block: RichBlock): BlockKind =>
  block.type === "paragraph" ? "paragraph" : block.type === "heading" ? (block.level === 2 ? "h2" : "h3") : block.ordered ? "ol" : "ul";

/** Flattens the items of a list into one line of text, separated by spaces. */
function joinItems(items: InlineText[][]): InlineText[] {
  return items.flatMap((item, i) => (i === 0 ? item : [{ text: " " }, ...item]));
}

function convert(block: RichBlock, kind: BlockKind): RichBlock {
  const content = block.type === "list" ? joinItems(block.items) : block.content;
  if (kind === "paragraph") return { type: "paragraph", content };
  if (kind === "h2" || kind === "h3") return { type: "heading", level: kind === "h2" ? 2 : 3, content };
  return { type: "list", ordered: kind === "ol", items: block.type === "list" ? block.items : [content] };
}

const emptyBlock = (kind: BlockKind): RichBlock => convert({ type: "paragraph", content: [] }, kind);

/** A new rich text holding one empty paragraph. */
export const emptyRichText = (): RichBlock[] => [emptyBlock("paragraph")];

/* DOM <-> structure */

function appendInlines(parent: HTMLElement, inlines: readonly InlineText[]): void {
  for (const inline of inlines) {
    let node: Node = document.createTextNode(inline.text);
    if (inline.italic) {
      const em = document.createElement("em");
      em.append(node);
      node = em;
    }
    if (inline.bold) {
      const strong = document.createElement("strong");
      strong.append(node);
      node = strong;
    }
    if (inline.href) {
      const a = document.createElement("a");
      a.href = inline.href;
      a.append(node);
      node = a;
    }
    parent.append(node);
  }
}

function renderBlock(root: HTMLElement, block: RichBlock): void {
  root.replaceChildren();
  if (block.type !== "list") {
    appendInlines(root, block.content);
    return;
  }
  const list = document.createElement(block.ordered ? "ol" : "ul");
  for (const item of block.items.length ? block.items : [[]]) {
    const li = document.createElement("li");
    appendInlines(li, item);
    list.append(li);
  }
  root.append(list);
}

interface Marks {
  bold?: boolean;
  italic?: boolean;
  href?: string;
}

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4"]);

function collect(node: Node, marks: Marks, out: InlineText[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/ /g, " ");
    if (text) out.push({ text, ...marks });
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  if (node.tagName === "BR") {
    out.push({ text: " ", ...marks });
    return;
  }
  const next: Marks = { ...marks };
  const weight = Number.parseInt(node.style.fontWeight, 10);
  if (node.tagName === "B" || node.tagName === "STRONG" || node.style.fontWeight === "bold" || weight >= 600) next.bold = true;
  if (node.tagName === "I" || node.tagName === "EM" || node.style.fontStyle === "italic") next.italic = true;
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (isHttpsUrl(href)) next.href = href;
  }
  if (BLOCK_TAGS.has(node.tagName) && out.length) out.push({ text: " ", ...marks });
  node.childNodes.forEach((child) => collect(child, next, out));
}

const sameMarks = (a: InlineText, b: InlineText) => !!a.bold === !!b.bold && !!a.italic === !!b.italic && a.href === b.href;

/** The inline texts of an element: adjacent runs with the same marks merged, surrounding spaces trimmed. */
function inlinesOf(element: Node): InlineText[] {
  const raw: InlineText[] = [];
  element.childNodes.forEach((child) => collect(child, {}, raw));
  const merged: InlineText[] = [];
  for (const run of raw) {
    const last = merged.at(-1);
    if (last && sameMarks(last, run)) last.text += run.text;
    else merged.push({ ...run });
  }
  const first = merged[0];
  if (first) first.text = first.text.replace(/^\s+/, "");
  const end = merged.at(-1);
  if (end) end.text = end.text.replace(/\s+$/, "");
  return merged
    .filter((r) => r.text !== "")
    .map((r) => ({ text: r.text, ...(r.bold ? { bold: true } : {}), ...(r.italic ? { italic: true } : {}), ...(r.href ? { href: r.href } : {}) }));
}

function readBlock(root: HTMLElement, block: RichBlock): RichBlock {
  if (block.type !== "list") return { ...block, content: inlinesOf(root) };
  const items = [...root.querySelectorAll("li")].map(inlinesOf).filter((item) => item.length > 0);
  if (!items.length && root.textContent?.trim()) items.push(inlinesOf(root));
  return { ...block, items };
}

/* Components */

function BlockEditable({
  block,
  label,
  autoFocus,
  onChange,
  onEnter,
  register,
}: {
  block: RichBlock;
  label: string;
  autoFocus: boolean;
  onChange: (block: RichBlock) => void;
  onEnter: () => void;
  register: (element: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef(block);
  useLayoutEffect(() => {
    if (!ref.current) return;
    renderBlock(ref.current, initial.current);
    if (autoFocus) ref.current.focus();
  }, [autoFocus]);
  const kind = kindOf(block);
  return (
    <div
      ref={(element) => {
        ref.current = element;
        register(element);
      }}
      className={`input site-rt-edit site-rt-${kind}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={block.type === "list"}
      aria-label={label}
      data-placeholder={block.type === "list" ? "Un élément par ligne" : "Saisissez le texte"}
      onInput={(e) => onChange(readBlock(e.currentTarget, block))}
      onKeyDown={(e) => {
        if (e.key === "Enter" && block.type !== "list") {
          e.preventDefault();
          if (!e.shiftKey) onEnter();
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
        document.execCommand("insertText", false, text);
      }}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

interface Item {
  key: number;
  block: RichBlock;
}

/** Rich text editor; remount it (change its key) to load another value. */
export function RichTextEditor({ value, onChange, label }: { value: RichBlock[]; onChange: (blocks: RichBlock[]) => void; label: string }) {
  const counter = useRef(0);
  const nextKey = () => (counter.current += 1);
  const [items, setItems] = useState<Item[]>(() => value.map((block) => ({ key: nextKey(), block })));
  const [focusKey, setFocusKey] = useState<number | null>(null);
  const [linking, setLinking] = useState<{ range: Range; key: number } | null>(null);
  const [url, setUrl] = useState("https://");
  const [hint, setHint] = useState<string | null>(null);
  const elements = useRef(new Map<number, HTMLDivElement>());

  const commit = (next: Item[]) => {
    setItems(next);
    onChange(next.map((i) => i.block));
  };
  const update = (key: number, block: RichBlock) => commit(items.map((i) => (i.key === key ? { key, block } : i)));
  const insertAfter = (index: number, kind: BlockKind) => {
    if (items.length >= SECTION_LIMITS.richBlocks) return;
    const key = nextKey();
    setFocusKey(key);
    commit([...items.slice(0, index + 1), { key, block: emptyBlock(kind) }, ...items.slice(index + 1)]);
  };
  /** Key of the block whose editable area holds the current selection. */
  const selectedBlock = (): { key: number; range: Range } | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    for (const [key, element] of elements.current) if (element.contains(range.commonAncestorContainer)) return { key, range };
    return null;
  };
  const reread = (key: number) => {
    const element = elements.current.get(key);
    const item = items.find((i) => i.key === key);
    if (element && item) update(key, readBlock(element, item.block));
  };
  const format = (command: "bold" | "italic" | "unlink") => {
    const selected = selectedBlock();
    if (!selected) {
      setHint("Placez d'abord le curseur dans le texte.");
      return;
    }
    setHint(null);
    document.execCommand(command);
    reread(selected.key);
  };
  const startLink = () => {
    const selected = selectedBlock();
    if (!selected || selected.range.collapsed) {
      setHint("Sélectionnez d'abord le texte du lien.");
      return;
    }
    setHint(null);
    setUrl("https://");
    setLinking({ range: selected.range.cloneRange(), key: selected.key });
  };
  const applyLink = () => {
    if (!linking) return;
    const element = elements.current.get(linking.key);
    if (element) {
      element.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(linking.range);
      document.execCommand("createLink", false, url.trim());
      reread(linking.key);
    }
    setLinking(null);
  };
  const keepSelection = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="stack site-rt" role="group" aria-label={label} style={{ gap: 8 }}>
      <div className="row center site-rt-toolbar" role="toolbar" aria-label="Mise en forme du texte" style={{ gap: 4 }}>
        <button type="button" className="btn" onMouseDown={keepSelection} onClick={() => format("bold")} title="Gras (Ctrl+B)">
          <strong>Gras</strong>
        </button>
        <button type="button" className="btn" onMouseDown={keepSelection} onClick={() => format("italic")} title="Italique (Ctrl+I)">
          <em>Italique</em>
        </button>
        <button type="button" className="btn" onMouseDown={keepSelection} onClick={startLink}>
          Lien
        </button>
        <button type="button" className="btn" onMouseDown={keepSelection} onClick={() => format("unlink")}>
          Retirer le lien
        </button>
        {hint ? (
          <span className="cap" role="status">
            {hint}
          </span>
        ) : null}
      </div>
      {items.map((item, index) => {
        const kind = kindOf(item.block);
        const name = `bloc ${index + 1} (${KIND_LABEL[kind].toLowerCase()})`;
        return (
          <div key={item.key} className="site-rt-block">
            <div className="row center between" style={{ gap: 6 }}>
              <select
                className="input site-rt-kind"
                aria-label={`Type du ${name}`}
                value={kind}
                onChange={(e) => {
                  setFocusKey(null);
                  update(item.key, convert(item.block, e.target.value as BlockKind));
                }}
              >
                {(Object.keys(KIND_LABEL) as BlockKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <span className="row center" style={{ gap: 2, flexWrap: "nowrap" }}>
                <MoveButtons label={`le ${name}`} index={index} count={items.length} onMove={(to) => commit(moveItem(items, index, to))} />
                <button
                  type="button"
                  className="btn btn-g"
                  aria-label={`Supprimer le ${name}`}
                  disabled={items.length === 1}
                  onClick={() => commit(items.filter((i) => i.key !== item.key))}
                >
                  Supprimer
                </button>
              </span>
            </div>
            <BlockEditable
              key={`${item.key}-${kind}`}
              block={item.block}
              label={`Texte du ${name}`}
              autoFocus={focusKey === item.key}
              onChange={(block) => update(item.key, block)}
              onEnter={() => insertAfter(index, "paragraph")}
              register={(element) => (element ? elements.current.set(item.key, element) : elements.current.delete(item.key))}
            />
          </div>
        );
      })}
      <div className="row center" style={{ gap: 4 }}>
        <span className="cap">Ajouter :</span>
        {(Object.keys(KIND_LABEL) as BlockKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className="btn btn-g"
            disabled={items.length >= SECTION_LIMITS.richBlocks}
            onClick={() => insertAfter(items.length - 1, k)}
          >
            + {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {linking ? (
        <Modal
          title="Ajouter un lien"
          onClose={() => setLinking(null)}
          footer={
            <>
              <span className="cap">Seules les adresses https:// sont acceptées</span>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn" onClick={() => setLinking(null)}>
                  Annuler
                </button>
                <button type="button" className="btn btn-p" disabled={!isHttpsUrl(url.trim())} onClick={applyLink}>
                  Ajouter le lien
                </button>
              </div>
            </>
          }
        >
          <Field label="Adresse du lien" error={url.trim() && url.trim() !== "https://" && !isHttpsUrl(url.trim()) ? "Adresse https:// attendue." : null}>
            <input className="input" type="url" value={url} maxLength={500} autoFocus onChange={(e) => setUrl(e.target.value)} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
