# Known Issues

## Windows 中文 IME 浮動框位置異常

**現象**: Windows 上使用中文輸入法時，IME 候選框有時會跑到畫面最右側。特別在 shell 顯示 placeholder/hint 文字（如自動補全提示）時容易觸發。

**原因**: xterm.js 的 `.xterm-helper-textarea` 在 composition 開始時未正確同步游標位置，導致 IME 候選框定位到 placeholder 文字尾端。

**上游 Issue**: [xtermjs/xterm.js#5734](https://github.com/xtermjs/xterm.js/issues/5734)

**修復狀態**: 已由 [PR #5759](https://github.com/xtermjs/xterm.js/pull/5759) 修復，目前僅包含在 `@xterm/xterm` 6.1.0-beta 中。等待 **6.1.0 正式版**發布後升級即可解決。

**目前版本**: `@xterm/xterm` 6.0.0
