import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { trackPageView } from '../../../shared/analytics/analytics';
import { AppDialog, InlineSpinner, useToast } from '../../../shared/ui';
import type { KnowledgeFolder, KnowledgeImage } from '../types';

/** 客户端预检上限（与 Main 侧 20MB 校验一致，提前拦截避免无效读取） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 兜底 MIME 映射：部分系统拖拽文件时 type 为空 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

type DeleteConfirm =
  | { kind: 'folder'; folder: KnowledgeFolder; imageCount: number }
  | { kind: 'image'; image: KnowledgeImage };

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readImageFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取文件“${file.name}”失败`));
    reader.onload = () => {
      const result = String(reader.result || '');
      // readAsDataURL 产物形如 data:<mime>;base64,<payload>，仅保留纯 base64 部分
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

interface ImageKnowledgeBasePageProps {
  /** 返回到知识库二级菜单页 */
  onBack?: () => void;
}

function ImageKnowledgeBasePage({ onBack }: ImageKnowledgeBasePageProps) {
  const { showToast } = useToast();
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState('');
  const [images, setImages] = useState<KnowledgeImage[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [listLoading, setListLoading] = useState(true);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [previewImage, setPreviewImage] = useState<KnowledgeImage | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeFolder = useMemo(
    () => folders.find((folder) => folder.id === activeFolderId) || null,
    [folders, activeFolderId],
  );

  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  const normalizedKeyword = searchKeyword.trim().toLowerCase();
  // 检索模式下展示跨文件夹结果，否则展示当前文件夹图片
  const displayImages = normalizedKeyword ? searchResults || [] : images;

  useEffect(() => {
    trackPageView('knowledge-image/library');
  }, []);

  const loadFolders = useCallback(async () => {
    try {
      setListLoading(true);
      const data = await window.yibiao?.knowledgeImage.listFolders();
      const nextFolders = data || [];
      setFolders(nextFolders);
      setActiveFolderId((currentId) => (
        nextFolders.some((folder) => folder.id === currentId) ? currentId : nextFolders[0]?.id || ''
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取图片文件夹失败', 'error');
    } finally {
      setListLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  // 网格缩略图按需懒加载：调用服务端生成的 400px JPEG 缩略图，避免传输整张原图
  useEffect(() => {
    const missing = displayImages.filter((image) => !thumbnails[image.id]);
    if (!missing.length) return;
    let cancelled = false;
    void (async () => {
      for (const image of missing) {
        try {
          const dataUrl = await window.yibiao?.knowledgeImage.getThumbnailUrl(image.id);
          if (cancelled) return;
          if (dataUrl) {
            setThumbnails((prev) => ({ ...prev, [image.id]: dataUrl }));
          }
        } catch {
          // 单张缩略图加载失败不阻断整页，占位样式兜底
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [displayImages, thumbnails]);

  // 跨文件夹检索：防抖后并发拉取各文件夹图片，按名称/描述/文件名/标签过滤
  useEffect(() => {
    if (!normalizedKeyword) {
      setSearchResults(null);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const groups = await Promise.all(
            folders.map((folder) => window.yibiao?.knowledgeImage.list(folder.id) ?? Promise.resolve([])),
          );
          if (cancelled) return;
          const matched = groups.flat().filter((image) => (
            [image.name, image.description, image.file_name, ...(image.tags || [])]
              .some((text) => String(text || '').toLowerCase().includes(normalizedKeyword))
          ));
          setSearchResults(matched);
        } catch (error) {
          if (!cancelled) {
            setSearchResults([]);
            showToast(error instanceof Error ? error.message : '检索图片失败', 'error');
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [normalizedKeyword, folders, showToast]);

  // 预览大图：优先复用缩略图缓存，未加载时按需拉取 data URL
  useEffect(() => {
    if (!previewImage || previewUrl) return undefined;
    let cancelled = false;
    setPreviewLoading(true);
    void (async () => {
      try {
        const dataUrl = await window.yibiao?.knowledgeImage.getDataUrl(previewImage.id);
        if (cancelled || !dataUrl) return;
        setPreviewUrl(dataUrl);
        setThumbnails((prev) => ({ ...prev, [previewImage.id]: dataUrl }));
      } catch {
        // 预览加载失败时保留占位提示，由用户关闭重试
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewImage, previewUrl]);

  const loadImages = useCallback(async (folderId: string) => {
    if (!folderId) {
      setImages([]);
      return;
    }
    try {
      setImagesLoading(true);
      const data = await window.yibiao?.knowledgeImage.list(folderId);
      setImages(data || []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '读取图片列表失败', 'error');
      setImages([]);
    } finally {
      setImagesLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    setThumbnails({});
    void loadImages(activeFolderId);
  }, [activeFolderId, loadImages]);

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      showToast('请输入文件夹名称', 'error');
      return;
    }
    try {
      setCreatingFolder(true);
      const folder = await window.yibiao?.knowledgeImage.createFolder(name);
      if (!folder) return;
      setFolders((prev) => [...prev, folder]);
      setActiveFolderId(folder.id);
      setNewFolderName('');
      setShowCreateFolder(false);
      showToast('文件夹已创建', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '创建文件夹失败', 'error');
    } finally {
      setCreatingFolder(false);
    }
  };

  const renameFolder = async (folderId: string, currentName: string) => {
    const name = window.prompt('请输入新的文件夹名称', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      const folder = await window.yibiao?.knowledgeImage.renameFolder(folderId, name);
      if (!folder) return;
      setFolders((prev) => prev.map((item) => (item.id === folder.id ? folder : item)));
      showToast('文件夹已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名文件夹失败', 'error');
    }
  };

  const requestDeleteFolder = () => {
    if (!activeFolder) return;
    setDeleteConfirm({ kind: 'folder', folder: activeFolder, imageCount: images.length });
  };

  const renameImage = async (image: KnowledgeImage) => {
    const name = window.prompt('请输入新的图片名称', image.name)?.trim();
    if (!name || name === image.name) return;
    try {
      const updated = await window.yibiao?.knowledgeImage.update(image.id, { name });
      if (!updated) return;
      setImages((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setSearchResults((prev) => (prev ? prev.map((item) => (item.id === updated.id ? updated : item)) : prev));
      setPreviewImage((prev) => (prev?.id === updated.id ? updated : prev));
      showToast('图片已重命名', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重命名图片失败', 'error');
    }
  };

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    // 清空 value 保证选择同一文件可再次触发 change
    event.target.value = '';
    if (!files.length || !activeFolder) return;

    const oversized = files.find((file) => file.size > MAX_IMAGE_BYTES);
    if (oversized) {
      showToast(`“${oversized.name}”超过 20MB 限制`, 'error');
      return;
    }

    try {
      setUploading(true);
      let successCount = 0;
      let lastError = '';
      for (const file of files) {
        const mimeType = file.type || MIME_BY_EXTENSION[file.name.slice(file.name.lastIndexOf('.')).toLowerCase()] || '';
        try {
          const base64 = await readImageFileAsBase64(file);
          await window.yibiao?.knowledgeImage.create(activeFolder.id, {
            base64,
            mimeType,
            fileName: file.name,
            name: file.name.replace(/\.[^.]+$/, ''),
          });
          successCount += 1;
        } catch (error) {
          lastError = error instanceof Error ? error.message : `上传“${file.name}”失败`;
        }
      }
      await loadImages(activeFolder.id);
      if (successCount) {
        showToast(`已上传 ${successCount} 张图片`, 'success');
      }
      if (lastError) {
        showToast(lastError, 'error');
      }
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteConfirm) return;
    try {
      setDeletingConfirm(true);
      if (deleteConfirm.kind === 'folder') {
        const { folder } = deleteConfirm;
        const result = await window.yibiao?.knowledgeImage.deleteFolder(folder.id);
        setDeleteConfirm(null);
        const nextFolders = folders.filter((item) => item.id !== folder.id);
        setFolders(nextFolders);
        if (activeFolderId === folder.id) {
          setActiveFolderId(nextFolders[0]?.id || '');
        }
        showToast(result?.message || '文件夹已删除', 'success');
      } else {
        const { image } = deleteConfirm;
        const result = await window.yibiao?.knowledgeImage.remove(image.id);
        setDeleteConfirm(null);
        setImages((prev) => prev.filter((item) => item.id !== image.id));
        setSearchResults((prev) => (prev ? prev.filter((item) => item.id !== image.id) : prev));
        setPreviewImage((prev) => (prev?.id === image.id ? null : prev));
        setThumbnails((prev) => {
          const next = { ...prev };
          delete next[image.id];
          return next;
        });
        showToast(result?.message || '图片已删除', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error');
    } finally {
      setDeletingConfirm(false);
    }
  };

  const openPreview = (image: KnowledgeImage) => {
    setPreviewImage(image);
    setPreviewUrl(thumbnails[image.id] || '');
    setPreviewLoading(false);
  };

  const closePreview = () => {
    setPreviewImage(null);
    setPreviewUrl('');
    setPreviewLoading(false);
  };

  return (
    <div className="page-stack knowledge-page">
      <section className="knowledge-workspace-bar">
        <div className="knowledge-breadcrumb">
          <span>图片知识库</span>
          <strong>{activeFolder?.name || '未选择文件夹'}</strong>
          <small>{folders.length} 个文件夹 / {images.length} 张图片</small>
        </div>
        <div className="knowledge-toolbar-actions">
          {onBack && <button type="button" className="secondary-action" onClick={onBack}>返回知识库</button>}
          <button type="button" className="secondary-action" onClick={() => setShowCreateFolder((value) => !value)} disabled={listLoading}>新建文件夹</button>
          <button type="button" className="secondary-action" onClick={requestDeleteFolder} disabled={listLoading || !activeFolder}>删除文件夹</button>
          <button type="button" className="primary-action" onClick={() => fileInputRef.current?.click()} disabled={uploading || !activeFolder}>
            {uploading ? '上传中...' : '上传图片'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml"
            multiple
            hidden
            onChange={(event) => { void handleFileSelect(event); }}
          />
        </div>
      </section>

      {showCreateFolder && (
        <form
          className="knowledge-create-folder-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="输入文件夹名称"
          />
          <button type="submit" className="primary-action" disabled={creatingFolder}>{creatingFolder ? '创建中...' : '创建'}</button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              setNewFolderName('');
              setShowCreateFolder(false);
            }}
          >
            取消
          </button>
        </form>
      )}

      <section className="knowledge-layout">
        <aside className="knowledge-folder-panel">
          <div className="knowledge-panel-head">
            <strong>文件夹</strong>
            <span>{folders.length} 个</span>
          </div>
          {listLoading ? (
            <div className="knowledge-empty-box">
              <strong>正在读取图片库...</strong>
              <p>请稍候，正在加载文件夹列表。</p>
            </div>
          ) : folders.length ? (
            <div className="knowledge-folder-list">
              {folders.map((folder) => (
                <article
                  key={folder.id}
                  className={`knowledge-folder-card ${folder.id === activeFolder?.id ? 'is-active' : ''}`}
                >
                  <div className="knowledge-folder-row">
                    <button
                      type="button"
                      className="knowledge-folder-main"
                      onClick={() => setActiveFolderId(folder.id)}
                    >
                      <span aria-hidden="true">I</span>
                      <strong>{folder.name}</strong>
                      <small>图片文件夹</small>
                    </button>
                  </div>
                  <div className="knowledge-folder-actions">
                    <button type="button" onClick={() => void renameFolder(folder.id, folder.name)}>重命名</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="knowledge-empty-box">
              <strong>还没有文件夹</strong>
              <p>点击右上角“新建文件夹”，再上传企业图片素材。</p>
            </div>
          )}
        </aside>

        <main className="knowledge-document-panel">
          <div className="knowledge-panel-head">
            <strong>{normalizedKeyword ? '搜索结果' : activeFolder?.name || '未选择文件夹'}</strong>
            <input
              type="search"
              className="knowledge-search-input"
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索图片名称 / 描述 / 标签"
              aria-label="搜索图片"
            />
            <span>{normalizedKeyword ? `${displayImages.length} 个匹配` : `${images.length} 张图片`}</span>
          </div>

          {normalizedKeyword ? (
            searching ? (
              <div className="knowledge-empty-box large">
                <strong>正在检索图片...</strong>
                <p>正在全部文件夹中查找“{searchKeyword.trim()}”。</p>
              </div>
            ) : displayImages.length ? (
              <div className="knowledge-image-grid">
                {displayImages.map((image) => (
                  <article key={image.id} className="knowledge-image-card">
                    <button type="button" className="knowledge-image-thumb knowledge-image-thumb-button" onClick={() => openPreview(image)} title="点击预览大图">
                      {thumbnails[image.id]
                        ? <img src={thumbnails[image.id]} alt={image.name} loading="lazy" />
                        : <span className="knowledge-image-placeholder" aria-hidden="true">加载中</span>}
                    </button>
                    <div className="knowledge-image-meta">
                      <strong title={image.name}>{image.name}</strong>
                      <small>{image.mime_type} · {formatSize(image.size)}</small>
                      <small className="knowledge-image-folder-badge">{folderNameById.get(image.folder_id) || '未知文件夹'}</small>
                    </div>
                    <div className="knowledge-image-actions">
                      <button type="button" onClick={() => openPreview(image)}>预览</button>
                      <button type="button" onClick={() => void renameImage(image)}>重命名</button>
                      <button type="button" className="is-danger" onClick={() => setDeleteConfirm({ kind: 'image', image })}>删除</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="knowledge-empty-box large">
                <strong>未找到匹配的图片</strong>
                <p>换个关键词试试，支持按名称、描述和标签检索全部文件夹。</p>
              </div>
            )
          ) : imagesLoading ? (
            <div className="knowledge-empty-box large">
              <strong>正在读取图片...</strong>
              <p>图片列表加载完成后会自动显示。</p>
            </div>
          ) : images.length ? (
            <div className="knowledge-image-grid">
              {images.map((image) => (
                <article key={image.id} className="knowledge-image-card">
                  <button type="button" className="knowledge-image-thumb knowledge-image-thumb-button" onClick={() => openPreview(image)} title="点击预览大图">
                    {thumbnails[image.id]
                      ? <img src={thumbnails[image.id]} alt={image.name} loading="lazy" />
                      : <span className="knowledge-image-placeholder" aria-hidden="true">加载中</span>}
                  </button>
                  <div className="knowledge-image-meta">
                    <strong title={image.name}>{image.name}</strong>
                    <small>{image.mime_type} · {formatSize(image.size)}</small>
                  </div>
                  <div className="knowledge-image-actions">
                    <button type="button" onClick={() => openPreview(image)}>预览</button>
                    <button type="button" onClick={() => void renameImage(image)}>重命名</button>
                    <button type="button" className="is-danger" onClick={() => setDeleteConfirm({ kind: 'image', image })}>删除</button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="knowledge-empty-box large">
              <strong>{activeFolder ? '还没有图片' : '未选择文件夹'}</strong>
              <p>{activeFolder ? '点击右上角“上传图片”，支持 PNG/JPEG/GIF/WebP/BMP/SVG，单张最大 20MB。' : '请在左侧选择或新建一个文件夹。'}</p>
              {activeFolder && (
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  上传图片
                </button>
              )}
            </div>
          )}
        </main>
      </section>

      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && closePreview()}>
        <Dialog.Portal>
          <Dialog.Overlay className="knowledge-source-modal" />
          {previewImage && (
            <Dialog.Content className="knowledge-image-preview-card">
              <div className="knowledge-source-head">
                <div>
                  <span>图片预览</span>
                  <Dialog.Title>{previewImage.name}</Dialog.Title>
                  <Dialog.Description>
                    {previewImage.mime_type} · {formatSize(previewImage.size)} · {folderNameById.get(previewImage.folder_id) || '未知文件夹'}
                  </Dialog.Description>
                </div>
                <button type="button" className="secondary-action" onClick={closePreview}>关闭</button>
              </div>
              <div className="knowledge-image-preview-body">
                {previewUrl ? (
                  <img src={previewUrl} alt={previewImage.name} />
                ) : (
                  <div className="knowledge-empty-box large">
                    {previewLoading && <InlineSpinner />}
                    <strong>{previewLoading ? '正在加载图片...' : '图片加载失败'}</strong>
                    <p>{previewLoading ? '图片较大时需要稍等片刻。' : '请关闭后重试。'}</p>
                  </div>
                )}
              </div>
            </Dialog.Content>
          )}
        </Dialog.Portal>
      </Dialog.Root>

      <AppDialog
        open={Boolean(deleteConfirm)}
        onOpenChange={(open) => !open && !deletingConfirm && setDeleteConfirm(null)}
        kicker="图片知识库"
        title={deleteConfirm?.kind === 'folder' ? `确定删除文件夹“${deleteConfirm.folder.name}”吗？` : `确定删除图片“${deleteConfirm?.kind === 'image' ? deleteConfirm.image.name : ''}”吗？`}
        description={deleteConfirm?.kind === 'folder' ? `其中 ${deleteConfirm.imageCount} 张图片也会一起删除，删除后不可恢复。` : '删除后不可恢复。'}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setDeleteConfirm(null)} disabled={deletingConfirm}>取消</button>
            <button type="button" className="danger-action" onClick={() => { void confirmDelete(); }} disabled={deletingConfirm}>
              {deletingConfirm ? '正在删除...' : '确认删除'}
            </button>
          </>
        )}
      />
    </div>
  );
}

export default ImageKnowledgeBasePage;
