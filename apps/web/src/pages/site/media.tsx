import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { api } from "../../api/client";
import { usePage } from "../../components/shell";
import { useToast } from "../../components/toasts";
import { Badge, Card, Empty, ErrorBanner, Field, Loading, Modal, PageHeader, Pagination, Segmented } from "../../components/ui";
import { frDate } from "../../lib/format";
import { mediaFileUrl, siteKeys, type MediaFile, type MediaList } from "./api";
import { ConfirmDialog } from "./common";

/** Longest side of an uploaded image; larger photos are scaled down in the browser before upload. */
const MAX_SIDE = 2560;
const WEBP_QUALITY = 0.85;
const PAGE_SIZE = 48;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Scales the image down to MAX_SIDE and encodes it as WebP, so uploads stay small whatever the camera produced.
 * A browser that cannot encode WebP returns PNG, which the API also accepts.
 */
async function prepareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", WEBP_QUALITY));
  if (!blob) throw new Error("image encoding failed");
  return readAsDataUrl(blob);
}

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.ceil(bytes / 1024)} Ko`);

/** Folder names in use, read from the first page of the active library. */
function useFolders(): string[] {
  const all = useQuery({
    queryKey: [...siteKeys.media, "folders"],
    queryFn: () => api.get<MediaList>("/media", { status: "active", pageSize: 200 }),
  });
  return [...new Set((all.data?.items ?? []).map((m) => m.folder).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b, "fr"));
}

function UploadModal({
  folders,
  defaultFolder,
  onClose,
  onUploaded,
}: {
  folders: string[];
  defaultFolder: string;
  onClose: () => void;
  onUploaded?: (m: MediaFile) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const listId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const [readError, setReadError] = useState(false);
  const upload = useMutation({
    mutationFn: async () => {
      setReadError(false);
      let image: string;
      try {
        image = await prepareImage(file!);
      } catch (error) {
        setReadError(true);
        throw error;
      }
      return api.post<MediaFile>("/media", { image, alt: alt.trim(), folder: folder.trim() });
    },
    onSuccess: async (media) => {
      await client.invalidateQueries({ queryKey: siteKeys.media });
      toast("Image ajoutée à la médiathèque.");
      onUploaded?.(media);
      onClose();
    },
  });
  return (
    <Modal
      title="Ajouter une image"
      onClose={onClose}
      footer={
        <>
          <span className="cap">Réduite à 2560 px et convertie en WebP avant l'envoi</span>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? <span className="spinner" aria-label="Envoi en cours" /> : "Envoyer"}
            </button>
          </div>
        </>
      }
    >
      <Field label="Fichier image *" hint="PNG, JPEG ou WebP">
        <input className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
      <Field label="Texte alternatif" hint="Décrit l'image pour les personnes malvoyantes et les moteurs de recherche.">
        <input className="input" value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
      </Field>
      <Field label="Dossier">
        <input className="input" list={listId} value={folder} maxLength={60} onChange={(e) => setFolder(e.target.value)} />
        <datalist id={listId}>
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      {readError ? (
        <div className="ban ban-red" role="alert">
          Cette image ne peut pas être lue par le navigateur. Choisissez un fichier PNG, JPEG ou WebP.
        </div>
      ) : (
        <ErrorBanner error={upload.error} />
      )}
    </Modal>
  );
}

function EditMediaModal({ media, folders, onClose }: { media: MediaFile; folders: string[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const listId = useId();
  const [alt, setAlt] = useState(media.alt ?? "");
  const [folder, setFolder] = useState(media.folder ?? "");
  const save = useMutation({
    mutationFn: () => api.patch<MediaFile>(`/media/${media.id}`, { alt: alt.trim(), folder: folder.trim() }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: siteKeys.media });
      toast("Image modifiée.");
      onClose();
    },
  });
  return (
    <Modal
      title="Modifier l'image"
      onClose={onClose}
      footer={
        <>
          <span />
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>
              Annuler
            </button>
            <button type="button" className="btn btn-p" disabled={save.isPending} onClick={() => save.mutate()}>
              Enregistrer
            </button>
          </div>
        </>
      }
    >
      <div className="site-media-thumb" style={{ maxWidth: 240 }}>
        <img src={mediaFileUrl(media.id)} alt="" />
      </div>
      <Field label="Texte alternatif">
        <input className="input" value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
      </Field>
      <Field label="Dossier">
        <input className="input" list={listId} value={folder} maxLength={60} onChange={(e) => setFolder(e.target.value)} />
        <datalist id={listId}>
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </Field>
      <ErrorBanner error={save.error} />
    </Modal>
  );
}

function FolderFilter({ folders, value, onChange }: { folders: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <select className="input" aria-label="Dossier" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Tous les dossiers</option>
      {folders.map((f) => (
        <option key={f} value={f}>
          {f}
        </option>
      ))}
    </select>
  );
}

export function MediaPage() {
  usePage(["Site web", "Médiathèque"]);
  const client = useQueryClient();
  const toast = useToast();
  const folders = useFolders();
  const [folder, setFolder] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<MediaFile | null>(null);
  const [archiving, setArchiving] = useState<MediaFile | null>(null);
  const list = useQuery({
    queryKey: [...siteKeys.media, "list", folder, status, page],
    queryFn: () => api.get<MediaList>("/media", { folder, status, page, pageSize: PAGE_SIZE }),
  });
  return (
    <>
      <PageHeader
        title="Médiathèque"
        subtitle="Images du site : bandeaux, galeries, logo et images de partage."
        actions={
          <button type="button" className="btn btn-p" onClick={() => setUploading(true)}>
            + Ajouter une image
          </button>
        }
      />
      <Card
        title={
          <div className="row center" style={{ gap: 8 }}>
            <Segmented
              label="Statut des images"
              value={status}
              onChange={(v) => (setStatus(v), setPage(1))}
              options={[
                { value: "active", label: "Actives" },
                { value: "archived", label: "Archivées" },
              ]}
            />
            <FolderFilter folders={folders} value={folder} onChange={(v) => (setFolder(v), setPage(1))} />
          </div>
        }
        footer={list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : undefined}
      >
        <ErrorBanner error={list.error} retry={() => list.refetch()} />
        {list.isPending ? (
          <Loading />
        ) : list.data?.items.length === 0 ? (
          <Empty title="Aucune image" {...(status === "active" ? { text: "Ajoutez des photos des espaces pour illustrer le site." } : {})} />
        ) : (
          <ul className="site-media-grid card-b">
            {list.data?.items.map((m) => (
              <li key={m.id} className="site-media-card">
                <div className="site-media-thumb">
                  <img src={mediaFileUrl(m.id)} alt={m.alt ?? ""} loading="lazy" />
                </div>
                <div className="stack" style={{ gap: 4, padding: "8px 10px" }}>
                  {m.alt ? <span className="site-clamp">{m.alt}</span> : <Badge tone="amber">Sans texte alternatif</Badge>}
                  <span className="cap">
                    {m.folder ?? "Sans dossier"} · {m.width} × {m.height} · {sizeText(m.bytes)}
                  </span>
                  <span className="cap">Ajoutée le {frDate(m.createdAt)}</span>
                  {m.status === "active" ? (
                    <div className="row site-media-actions">
                      <button type="button" className="btn btn-g" aria-label={`Modifier l'image ${m.alt ?? ""}`.trim()} onClick={() => setEditing(m)}>
                        Modifier
                      </button>
                      <button type="button" className="btn btn-g" aria-label={`Archiver l'image ${m.alt ?? ""}`.trim()} onClick={() => setArchiving(m)}>
                        Archiver
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {uploading ? <UploadModal folders={folders} defaultFolder={folder} onClose={() => setUploading(false)} /> : null}
      {editing ? <EditMediaModal media={editing} folders={folders} onClose={() => setEditing(null)} /> : null}
      {archiving ? (
        <ConfirmDialog
          title="Archiver l'image"
          confirmLabel="Archiver"
          danger
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            await api.post(`/media/${archiving.id}/archive`);
            await client.invalidateQueries({ queryKey: siteKeys.media });
            toast("Image archivée.");
          }}
        >
          L'image quitte la médiathèque et ne peut plus être choisie. Les pages déjà publiées qui l'affichent la gardent.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

/** Library browser to choose an image, with upload in place; used by the page editor and the appearance screen. */
export function MediaPickerModal({ title, onSelect, onClose }: { title: string; onSelect: (media: MediaFile) => void; onClose: () => void }) {
  const folders = useFolders();
  const [folder, setFolder] = useState("");
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const list = useQuery({
    queryKey: [...siteKeys.media, "list", folder, "active", page],
    queryFn: () => api.get<MediaList>("/media", { folder, status: "active", page, pageSize: PAGE_SIZE }),
  });
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          {list.data ? <Pagination page={page} hasMore={list.data.hasMore} onPage={setPage} /> : <span />}
          <button type="button" className="btn" onClick={onClose}>
            Fermer
          </button>
        </>
      }
    >
      <div className="row between center">
        <FolderFilter folders={folders} value={folder} onChange={(v) => (setFolder(v), setPage(1))} />
        <button type="button" className="btn" onClick={() => setUploading(true)}>
          + Ajouter une image
        </button>
      </div>
      <ErrorBanner error={list.error} retry={() => list.refetch()} />
      {list.isPending ? (
        <Loading />
      ) : list.data?.items.length === 0 ? (
        <Empty title="Aucune image" text="Ajoutez une image pour la choisir." />
      ) : (
        <ul className="site-media-grid">
          {list.data?.items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                className="site-media-card site-media-pick"
                onClick={() => (onSelect(m), onClose())}
                aria-label={`Choisir ${m.alt || `l'image ${m.width} × ${m.height}`}`}
              >
                <span className="site-media-thumb">
                  <img src={mediaFileUrl(m.id)} alt="" loading="lazy" />
                </span>
                <span className="cap site-clamp" style={{ padding: "6px 8px" }}>
                  {m.alt || m.folder || `${m.width} × ${m.height}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploading ? (
        <UploadModal folders={folders} defaultFolder={folder} onClose={() => setUploading(false)} onUploaded={(m) => (onSelect(m), onClose())} />
      ) : null}
    </Modal>
  );
}

/** An optional image of the site: thumbnail, choose from the library, remove. */
export function ImageField({
  label,
  value,
  onChange,
  hint,
  error,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  hint?: string | undefined;
  error?: string | null | undefined;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="field">
      <span className="lab">{label}</span>
      <div className="row center" style={{ gap: 10 }}>
        <span className="site-image-slot">{value ? <img src={mediaFileUrl(value)} alt="" /> : <span className="cap">Aucune image</span>}</span>
        <button type="button" className="btn" onClick={() => setPicking(true)}>
          {value ? "Changer" : "Choisir"}
          <span className="visually-hidden"> : {label}</span>
        </button>
        {value ? (
          <button type="button" className="btn btn-g" onClick={() => onChange(null)}>
            Retirer
            <span className="visually-hidden"> : {label}</span>
          </button>
        ) : null}
      </div>
      {hint ? <span className="cap">{hint}</span> : null}
      {error ? <span className="err-text">{error}</span> : null}
      {picking ? <MediaPickerModal title={label} onSelect={(m) => onChange(m.id)} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
