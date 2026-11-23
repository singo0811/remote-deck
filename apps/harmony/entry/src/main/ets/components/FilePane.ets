import { common } from '@kit.AbilityKit';
import { picker, fileIo } from '@kit.CoreFileKit';
import {
  FileItem,
  FileRoot,
  FrameKind,
  MsgType,
  OutMetaFileUp,
  OutMsgFsUploadEnd,
  OutMsgFsUploadStart,
  formatBytes,
} from '../protocol/Protocol';
import { RemoteClient } from '../protocol/RemoteClient';

@Component
export struct FilePane {
  @Prop roots: FileRoot[] = [];
  @Prop currentPath: string = '';
  @Prop parentPath: string = '';
  @Prop items: FileItem[] = [];
  @Prop loading: boolean = false;
  @Prop editingPath: string = '';
  @Prop @Watch('onEditingContentChange') editingContent: string = '';
  @Prop editingTruncated: boolean = false;
  client: RemoteClient | null = null;

  onCloseEditor: () => void = () => {};
  onToast: (msg: string) => void = () => {};

  @State modalKind: string = ''; // '' | 'mkdir' | 'rename' | 'delete'
  @State modalInput: string = '';
  @State modalTargetItem: FileItem | null = null;
  @State draftText: string = '';
  @State uploadPct: number = -1;
  @State selectedPaths: string[] = [];

  private isSelected(path: string): boolean {
    return this.selectedPaths.indexOf(path) >= 0;
  }

  private toggleSelected(path: string): void {
    const next: string[] = [];
    let removed = false;
    for (let i = 0; i < this.selectedPaths.length; i++) {
      if (this.selectedPaths[i] === path) {
        removed = true;
      } else {
        next.push(this.selectedPaths[i]);
      }
    }
    if (!removed) {
      next.push(path);
    }
    this.selectedPaths = next;
  }

  private zipSelected(): void {
    const paths = this.selectedPaths.length > 0
      ? this.selectedPaths
      : (this.currentPath.length > 0 ? [this.currentPath] : []);
    if (paths.length === 0) return;
    this.client?.requestFsZipDownload(paths);
    this.onToast(`正在打包 ${paths.length} 项`);
    this.selectedPaths = [];
  }

  aboutToAppear(): void {
    this.draftText = this.editingContent;
  }

  onEditingContentChange(): void {
    this.draftText = this.editingContent;
  }

  private sepFor(p: string): string {
    return p.indexOf('\\') >= 0 ? '\\' : '/';
  }

  private async pickAndUpload(): Promise<void> {
    if (!this.client || !this.currentPath) return;
    try {
      const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const docPicker = new picker.DocumentViewPicker(ctx);
      const uris = await docPicker.select({ maxSelectNumber: 1 });
      if (!uris || uris.length === 0) return;

      const uri = uris[0];
      const slashIdx = uri.lastIndexOf('/');
      const rawName = slashIdx >= 0 ? uri.slice(slashIdx + 1) : 'upload.bin';
      const fileName = decodeURIComponent(rawName);
      const f = fileIo.openSync(uri, fileIo.OpenMode.READ_ONLY);
      const st = fileIo.statSync(f.fd);
      const total = st.size;
      const transferId = `up-${Date.now()}`;

      const startMsg: OutMsgFsUploadStart = {
        type: MsgType.FS_UPLOAD_START,
        reqId: `us-${Date.now()}`,
        transferId,
        dirPath: this.currentPath,
        fileName,
        total,
      };
      this.client.sendJson(startMsg);

      const chunkSize = 64 * 1024;
      const buf = new ArrayBuffer(chunkSize);
      let offset = 0;
      this.uploadPct = 0;
      while (offset < total || total === 0) {
        const readLen = total === 0 ? 0 : fileIo.readSync(f.fd, buf, { offset, length: chunkSize });
        offset += readLen;
        const done = offset >= total;
        const slice = new Uint8Array(buf.slice(0, readLen));
        const meta: OutMetaFileUp = { transferId, done };
        this.client.sendBinary(FrameKind.FILE_UP, meta, slice);
        this.uploadPct = total > 0 ? Math.round((offset / total) * 100) : 100;
        if (done) break;
      }
      fileIo.closeSync(f);
      const endMsg: OutMsgFsUploadEnd = {
        type: MsgType.FS_UPLOAD_END,
        reqId: `ue-${Date.now()}`,
        transferId,
      };
      this.client.sendJson(endMsg);
      this.uploadPct = -1;
    } catch {
      this.uploadPct = -1;
      this.onToast('选择或上传文件失败');
    }
  }

  private submitModal(): void {
    if (!this.client) return;
    if (this.modalKind === 'mkdir') {
      const name = this.modalInput.trim();
      if (name) {
        const sep = this.sepFor(this.currentPath);
        const target = this.currentPath.endsWith(sep)
          ? `${this.currentPath}${name}`
          : `${this.currentPath}${sep}${name}`;
        this.client.requestFsMkdir(target);
      }
    } else if (this.modalKind === 'rename' && this.modalTargetItem) {
      const nextName = this.modalInput.trim();
      if (nextName && nextName !== this.modalTargetItem.name) {
        const p = this.modalTargetItem.path;
        const sep = this.sepFor(p);
        const dir = p.slice(0, p.lastIndexOf(sep));
        this.client.requestFsRename(p, `${dir}${sep}${nextName}`);
      }
    } else if (this.modalKind === 'delete' && this.modalTargetItem) {
      this.client.requestFsDelete(this.modalTargetItem.path);
    }
    this.modalKind = '';
    this.modalInput = '';
    this.modalTargetItem = null;
  }

  build() {
    Stack() {
      Column() {
        Scroll() {
          Row({ space: 6 }) {
            ForEach(this.roots, (r: FileRoot) => {
              Button(r.name)
                .height(30)
                .fontSize(12)
                .backgroundColor(this.currentPath.startsWith(r.path) ? '#1E3A5F' : '#1A2232')
                .fontColor(this.currentPath.startsWith(r.path) ? '#38BDF8' : '#E2E8F0')
                .borderRadius(6)
                .onClick(() => {
                  this.client?.requestFsList(r.path);
                })
            }, (r: FileRoot) => r.path)
          }
          .padding({ left: 10, right: 10, top: 8, bottom: 8 })
        }
        .scrollable(ScrollDirection.Horizontal)
        .scrollBar(BarState.Off)
        .width('100%')
        .backgroundColor('#121824')

        Row({ space: 6 }) {
          if (this.parentPath.length > 0) {
            Button('上级')
              .height(30)
              .fontSize(12)
              .backgroundColor('#1A2232')
              .fontColor('#E2E8F0')
              .borderRadius(6)
              .onClick(() => {
                this.client?.requestFsList(this.parentPath);
              })
          }

          Text(this.currentPath || '加载中...')
            .fontSize(12)
            .fontColor('#94A3B8')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)

          Button('+ 目录')
            .height(30)
            .fontSize(12)
            .backgroundColor('#1A2232')
            .fontColor('#E2E8F0')
            .borderRadius(6)
            .onClick(() => {
              this.modalKind = 'mkdir';
              this.modalInput = '';
              this.modalTargetItem = null;
            })

          Button(this.uploadPct >= 0 ? `${this.uploadPct}%` : '上传')
            .height(30)
            .fontSize(12)
            .backgroundColor('#38BDF8')
            .fontColor('#082F49')
            .borderRadius(6)
            .onClick(() => {
              void this.pickAndUpload();
            })

          Button(this.selectedPaths.length > 0 ? `打包(${this.selectedPaths.length})` : '打包')
            .height(30)
            .fontSize(12)
            .backgroundColor(this.selectedPaths.length > 0 ? '#1E3A5F' : '#1A2232')
            .fontColor(this.selectedPaths.length > 0 ? '#38BDF8' : '#E2E8F0')
            .borderRadius(6)
            .onClick(() => {
              this.zipSelected();
            })

          Button('刷新')
            .height(30)
            .fontSize(12)
            .backgroundColor('#1A2232')
            .fontColor('#E2E8F0')
            .borderRadius(6)
            .onClick(() => {
              if (this.currentPath) {
                this.client?.requestFsList(this.currentPath);
              } else {
                this.client?.requestFsRoots();
              }
            })
        }
        .width('100%')
        .padding({ left: 10, right: 10, bottom: 8 })
        .backgroundColor('#121824')
        .border({ width: { bottom: 1 }, color: '#253147' })

        if (this.editingPath.length > 0) {
          Column({ space: 8 }) {
            Row({ space: 8 }) {
              Text(this.editingPath)
                .fontSize(12)
                .fontColor('#38BDF8')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .layoutWeight(1)

              if (!this.editingTruncated) {
                Button('保存')
                  .height(30)
                  .fontSize(12)
                  .backgroundColor('#34D399')
                  .fontColor('#064E3B')
                  .borderRadius(6)
                  .onClick(() => {
                    this.client?.requestFsWriteText(this.editingPath, this.draftText);
                  })
              }

              Button('关闭')
                .height(30)
                .fontSize(12)
                .backgroundColor('#1A2232')
                .fontColor('#E2E8F0')
                .borderRadius(6)
                .onClick(() => {
                  this.onCloseEditor();
                })
            }
            .width('100%')

            TextArea({ text: this.editingContent })
              .layoutWeight(1)
              .width('100%')
              .fontSize(12)
              .fontFamily('monospace')
              .fontColor('#E2E8F0')
              .backgroundColor('#06090F')
              .borderRadius(8)
              .onChange((v: string) => {
                this.draftText = v;
              })
          }
          .width('100%')
          .layoutWeight(1)
          .padding(12)
          .backgroundColor('#0B0F17')
        } else if (this.loading) {
          Column({ space: 8 }) {
            LoadingProgress().width(32).height(32).color('#38BDF8')
            Text('正在读取目录...').fontSize(12).fontColor('#94A3B8')
          }
          .width('100%')
          .layoutWeight(1)
          .justifyContent(FlexAlign.Center)
        } else {
          List({ space: 6 }) {
            ForEach(this.items, (item: FileItem) => {
              ListItem() {
                Row({ space: 8 }) {
                  Checkbox({ name: item.path, group: 'rd-files' })
                    .select(this.isSelected(item.path))
                    .selectedColor('#38BDF8')
                    .width(22)
                    .height(22)
                    .onChange(() => {
                      this.toggleSelected(item.path);
                    })

                  Text(item.isDir ? '📁' : '📄')
                    .fontSize(16)
                  Column({ space: 2 }) {
                    Text(item.name)
                      .fontSize(14)
                      .fontColor('#E2E8F0')
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                    Text(item.isDir ? '文件夹' : formatBytes(item.size))
                      .fontSize(11)
                      .fontColor('#64748B')
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                  .onClick(() => {
                    if (item.isDir) {
                      this.client?.requestFsList(item.path);
                    } else {
                      this.client?.requestFsReadText(item.path);
                    }
                  })

                  if (!item.isDir) {
                    Button('下载')
                      .height(28)
                      .fontSize(11)
                      .backgroundColor('#1A2232')
                      .fontColor('#38BDF8')
                      .borderRadius(6)
                      .onClick(() => {
                        this.client?.requestFsDownload(item.path);
                      })
                  }

                  Button('改名')
                    .height(28)
                    .fontSize(11)
                    .backgroundColor('#1A2232')
                    .fontColor('#E2E8F0')
                    .borderRadius(6)
                    .onClick(() => {
                      this.modalKind = 'rename';
                      this.modalInput = item.name;
                      this.modalTargetItem = item;
                    })

                  Button('删')
                    .height(28)
                    .fontSize(11)
                    .backgroundColor('#451A22')
                    .fontColor('#FCA5A5')
                    .borderRadius(6)
                    .onClick(() => {
                      this.modalKind = 'delete';
                      this.modalTargetItem = item;
                    })
                }
                .width('100%')
                .padding(10)
                .backgroundColor('#121824')
                .borderRadius(10)
                .border({ width: 1, color: '#253147' })
              }
            }, (item: FileItem) => item.path)
          }
          .width('100%')
          .layoutWeight(1)
          .padding(10)
          .backgroundColor('#0B0F17')
        }
      }
      .width('100%')
      .height('100%')

      if (this.modalKind.length > 0) {
        Column() {
          Column({ space: 12 }) {
            Text(
              this.modalKind === 'mkdir'
                ? '新建文件夹'
                : this.modalKind === 'rename'
                  ? '重命名'
                  : `确认删除 "${this.modalTargetItem?.name || ''}"？`
            )
              .fontSize(15)
              .fontWeight(FontWeight.Bold)
              .fontColor('#E2E8F0')

            if (this.modalKind !== 'delete') {
              TextInput({ text: this.modalInput, placeholder: '请输入名称' })
                .height(40)
                .fontSize(14)
                .fontColor('#E2E8F0')
                .backgroundColor('#0B0F17')
                .borderRadius(8)
                .border({ width: 1, color: '#253147' })
                .onChange((val: string) => {
                  this.modalInput = val;
                })
            }

            Row({ space: 10 }) {
              Button('取消')
                .layoutWeight(1)
                .height(38)
                .backgroundColor('#1A2232')
                .fontColor('#94A3B8')
                .borderRadius(8)
                .onClick(() => {
                  this.modalKind = '';
                })
              Button(this.modalKind === 'delete' ? '确认删除' : '确定')
                .layoutWeight(1)
                .height(38)
                .backgroundColor(this.modalKind === 'delete' ? '#F87171' : '#38BDF8')
                .fontColor('#082F49')
                .borderRadius(8)
                .onClick(() => {
                  this.submitModal();
                })
            }
            .width('100%')
          }
          .width('86%')
          .constraintSize({ maxWidth: 380 })
          .padding(16)
          .backgroundColor('#1A2232')
          .borderRadius(12)
          .border({ width: 1, color: '#38BDF8' })
        }
        .width('100%')
        .height('100%')
        .backgroundColor('#AA000000')
        .justifyContent(FlexAlign.Center)
      }
    }
    .width('100%')
    .height('100%')
  }
}
