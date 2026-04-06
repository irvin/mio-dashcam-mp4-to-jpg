# mio-dashcam-convert 檢視筆記

日期：2026-04-06

## 主要發現

### 1. XMP 尚未實作，與計畫描述仍有落差

- `PLAN.md` 目前仍以「EXIF／XMP」作為主要輸出目標。
- `extract.js` 目前只透過 `exiftool.write()` 寫入 EXIF 欄位，沒有額外寫 XMP。
- `README.md` 已有提示「若需與 PLAN §4.3 完全同步，可再以 ExifTool 加寫」，表示實作層其實已經縮成「先做 EXIF」。

建議：

- 若近期不打算做 XMP，應把 `PLAN.md` 的主目標改成「先完成 EXIF，XMP 為後續擴充」。
- 若要維持目前計畫文字，就應在 `extract.js` 補上 XMP mirror 寫入，並把欄位範圍定清楚。

### 2. GGA 品質降級有在 console 顯示，但沒有落到輸出檔或 sidecar

- `PLAN.md` 已寫明：最近鄰合併若超過門檻，應「留空並標記品質降級」。
- `extract.js` 現在的做法是：
  - 超過 `--gga-max-delta-ms` 時，不寫海拔／HDOP
  - 在 console 印出 `GGA略過(Δxxxms)`
- 但最終 JPEG 裡沒有留下這個資訊，也沒有 sidecar JSON／CSV manifest。

影響：

- 之後只拿到輸出的 JPEG 時，看不出哪幾張是「GPS 主座標有效，但 GGA 延伸欄位其實已降級」。
- 驗收與除錯時，無法回溯每張圖的對時品質。

建議：

- 至少輸出一份 `manifest.json` 或 `manifest.csv`，記錄：
  - 檔名
  - UTC
  - frame index
  - `gga_delta_ms`
  - `gga_used`
  - `gps_offset`（整數筆數，CLI：`--gps-offset`）
- 若想讓單檔自描述更完整，可再把簡短說明寫入 `UserComment`。

### 3. GGA 日期是用第一筆 RMC 的日期硬套，跨午夜會錯

- `attachGgaUtcMs()` 目前直接拿第一筆 RMC 的日期，套到所有 GGA。
- 這對目前 120 秒範例通常沒事，但只要碰到接近 UTC 午夜的長片段，GGA 會在日期翻轉後被算錯一天。

影響：

- `nearestGga()` 會選錯筆。
- 海拔、HDOP、衛星數等延伸欄位可能整段錯配。

建議：

- 不要把所有 GGA 都綁死在第一筆 RMC 日期。
- 較穩的做法：
  - 先依時間字串建立單調遞增的 GGA 時間軸，遇到回捲則進位一天。
  - 或改成以 RMC 為主時鐘，對每筆 GGA 依鄰近 RMC 推算日期。

### 4. 計畫文件目前有 Markdown 語法污染，閱讀性已受影響

- `PLAN.md` 內有多處殘留的 `**`，像是：
  - `**013546`
  - `**t = 0`
  - `**$GNRMC`
  - `**-q:v 1`
- 這看起來像前一次編修時的 markdown 強調標記沒有收乾淨。

影響：

- 文件可讀性下降。
- 後續若再據此實作，容易把格式噪音誤認為規格本身。

建議：

- 先做一次純文件清理，把多餘的 `**` 全部移除。
- 這個修正不牽涉行為改動，應優先處理。

### 5. 計畫要求「必做校正」，但 repo 內還沒有專門支援這一步的輸出模式

- `PLAN.md` 已把「先抽樣驗證，求出 `gps_offset`」列為必做。
- `README.md` 已建議用 **校正模式**（`--sample-duration`／`--sample-step`）對疊字試 `gps_offset`。
- `extract.js` 沒有提供專門的「校正抽樣」模式，例如：
  - 只抽指定秒段
  - 每 0.5 秒抽一張
  - 附帶時間疊字資訊輸出 manifest

影響：

- 校正流程仍要靠人工拼指令，容易每次做法不同。
- 計畫寫的是標準流程，但腳本尚未把流程產品化。

建議：

- 新增一個最小功能即可：
  - `--sample-start`
  - `--sample-duration`
  - `--sample-step`
- 或新增 `calibrate.js`，專門用來輸出校正樣本與對應 UTC。

## 優先調整順序

1. 清理 `PLAN.md` 的 Markdown 污染，避免規格文件持續失真。
2. 決定產品範圍到底是「EXIF only」還是「EXIF + XMP」，讓文件與腳本一致。
3. 增加 manifest 輸出，把 GGA 合併品質與 frame 對應資訊固化下來。
4. 補上校正抽樣模式，讓 `gps_offset` 的求法可重複。
5. 修正 GGA 跨午夜日期推算，補掉長片段的邊界錯誤。

## 建議的最小下一步

如果下一輪要優先動手改程式，建議先做這一組：

1. `PLAN.md` 純文字清理。
2. `extract.js` 輸出 `manifest.json`。
3. `README.md` 補上校正抽樣的標準操作方式。

這三件做完後，文件、驗收與實際批次輸出會先對齊；之後再決定要不要補 XMP 與專用校正模式。