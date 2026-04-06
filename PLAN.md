# Mio 行車記錄器：依 NMEA 截圖並寫入 GPS Metadata

## 1. 目標

從 **MP4 影像**依 **NMEA 時間軸**擷取對應畫面（靜態圖），並將該時刻的 GPS 與相關導航資訊以**標準 EXIF／XMP** 為主寫入圖檔，供地圖、相簿或後續 GIS 使用。

## 2. 輸入檔案特性（已檢視）

### 2.1 影片（例：`FILE260403-103546F.mp4`）


| 項目                      | 數值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| 解析度                     | 2560×1440                                                          |
| 編碼                      | H.264（Main），yuv420p                                                |
| 長度                      | 約 120.07 s                                                         |
| 幀率                      | CFR 約 **15 fps**（`r_frame_rate = 15/1`，抽樣幀時間間隔約 1/15 s）            |
| 總幀數                     | 約 **1801**                                                         |
| 音訊                      | PCM s16le，16 kHz，單聲道（截圖流程可不使用）                                     |
| 容器 metadata             | **無** `creation_time`；僅見 `encoder=Lavf58.20.100` 等，**不可依賴 MP4 對時** |
| 第三軌 `SStarMeta`（`ssmd`） | 廠商二進位（內含 JPEG 片段），**不作為標準 GPS 來源**；若未來要解析需另定規格                     |


### 2.2 NMEA（例：`FILE260403-103546F.NMEA`）

- **時間跨度**與影片長度一致：約 **120 秒**（例：RMC 自 `013546` UTC 至約 `013746` UTC）。
- **句子統計（參考）**：`$GNRMC` 120、`$GNGGA` 120、`$GNVTG`／`$GNZDA`／`$GNGLL` 各 120、`$GNGSA` 360（每曆元 3 句）、`$GPGSV`／`$BDGSV` 各 480、`$GLGSV` 240、`$GSENSORD` 107（**筆數與 RMC 不完全一致**，對齊時需內插或最近鄰）。

**建議採用欄位來源：**


| 用途                        | 主要句子        | 備註                                               |
| ------------------------- | ----------- | ------------------------------------------------ |
| 時間、座標、對地速度（節）、航向、日期       | `$GNRMC`    | 狀態為 `A` 才採用                                      |
| 海拔、HDOP、衛星數、Fix quality   | `$GNGGA`    | 與 RMC **時間可能差 1～2 秒**，需依 UTC 合併最近一筆              |
| 速度／航向（備援）                 | `$GNVTG`    | 與 RMC 重複時可擇一或交叉檢查                                |
| PDOP／HDOP／VDOP、使用中之衛星 PRN | `$GNGSA`    | 每曆元多句，需合併語意或選「主星座」那組                             |
| 每顆衛星高度角／方位角／SNR           | `$GPGSV` 等  | 資料量大，**不建議全寫 EXIF**；可 sidecar JSON 或 UserComment |
| 加速度／感測器                   | `$GSENSORD` | **非標準 NMEA**，寫入照片需自訂 XMP／註解                      |


### 2.3 對時錨點（強烈建議）

- NMEA 第一筆有效 RMC 之 UTC 與檔名 `FILE260403-103546F`（若代表 **本地 10:35:46**）換算後，可與 `**013546` UTC** 對齊（例：JST → UTC）。
- **暫定假設**：影片時間 `**t = 0` s** 對應 **該 RMC 之 UTC 時刻**（例：`2026-04-03T01:35:46.000Z`）。
- **必做校正**：先輸出開頭少數張候選 frame（例如 **`--sample-duration 8`** 只取前 8 筆 RMC 錨點），或全片以 **`--sample-step`**、不帶 `--sample-duration` 抽樣，人工比對畫面疊字、事件點或其他可觀察線索，求出固定 **`gps_offset`（整數筆數）**；批次輸出時一律套用。實作上建議**校正模式**搭配 **NMEA** 與 `--offset`：JPEG **仍寫入與一般模式相同之 EXIF GPS**，並在左下角**另**疊印 **UTC／本地時間**與 **WGS84**，與機台時間／座標疊字對照。

對時與 **gps_offset**（實作）：

```text
t_base = (該筆 RMC 之 UTC − UTC0) / 1s     （軌跡／抽樣時間，秒；用於算 frame_index、擷取幀）
GPS 寫入列 = rmcList[ 錨點索引 + gps_offset ]   （一般模式：錨點＝該迴圈 i；校正模式：錨點＝依 --sample-step 取樣之 RMC 索引 i）
```

其中 `UTC0` 由第一筆有效 `$GNRMC`（或與製造商文件一致的規則）決定。  
**擷取幀**先依 **t_base** 得 **frame_index**，可選 **`--frame-offset`** 加減整數幀（再 clamp）；**不**因 `gps_offset` 改影片時間（`gps_offset` 只改 GPS 用 RMC）。**`gps_offset = -1`** 表示 EXIF／疊印改用**軌跡上更早一筆** RMC。索引越界則略過並警告。一般模式對每筆有效 RMC 曆元輸出一張（依 **t_base**）；校正模式依 **`--sample-step`（整數 N≥1）** 在 **`rmcList` 上每隔 N 筆取一錨點**（`i += N`），並可選 **`--sample-start`**（略過 `t_base` 過小的錨點）與 **`--sample-duration`**（最多輸出 **M** 筆成功之 job）。

## 3. 輸出策略

### 3.1 擷取頻率與幀選擇（已定案：整數 fps 取該曆秒**第一幀**）

- **預設**：每個 `**$GNRMC` 曆元（約 1 Hz）** 輸出一張，或改為**每 N 秒一張**（可設定）。
- **幀選擇**（CFR、**fps 為整數**，例如 **15 fps**）：令 **t_base**（§2.3），`s = floor(t_base)`、`fps` 為整數幀率，取該曆秒區間內**第一**幀（該秒索引 0 之 frame）：
  ```text
  frame_index = s * fps
  ```
  例：15 fps 時為 `s * 15`（第 `s` 秒之第 1 個 frame，0-based 索引為 `s*15`）。**非整數 fps**（如 29.97）實作上可退回 `floor(t_base * fps)` 以避免每秒幀數非整數時定義曖昧。邊界與越界（`frame_index` 超過總幀數）需 clamp 或略過。
- **實作要求**：截圖工具需以 **frame index 為準**取圖，不以單純 `-ss` 秒數 seek 取代；需用可精準指定幀的方式（例如先取得實際 frame timestamp，或用 frame-based filter）避免落到鄰近幀。
- **備註**：若畫面與 GPS 軌跡有固定「差幾筆」的對齊誤差，以 **`gps_offset`（整數筆）** 調整 EXIF／疊印之 RMC，**不**改變擷取幀。

### 3.2 影像格式

- **固定輸出 JPEG**：**EXIF GPS** 相容性最佳，本計畫 **不處理 PNG**。

### 3.3 工具鏈（建議）

- **截圖**：`ffmpeg`（`-ss` 置於 `-i` 前或後之取捨需依精度需求文件化；大量輸出可考慮 filter 批次）。**MJPEG 以畫質為優先**時預設 `**-q:v 1`**（見 §8.3）。
- **寫入 metadata**：**ExifTool**（CLI）或 Node `**exiftool-vendored`**，便於一次寫入多欄位並驗證。

## 4. Metadata 寫入清單（標準優先）

### 4.1 EXIF GPS IFD（建議盡量填滿）


| EXIF 概念                         | 資料來源                                    |
| ------------------------------- | --------------------------------------- |
| 緯度／經度 + Ref                     | `$GNRMC` 或 `$GNGGA`（轉十進位再寫入）            |
| 海拔 + Ref                        | `$GNGGA`                                |
| `GPSTimeStamp` + `GPSDateStamp` | RMC／GGA 之 UTC                           |
| `GPSMapDatum`                   | `WGS-84`                                |
| `GPSDOP`                        | GGA 之 HDOP 或 GSA 之 HDOP（**欄位定義需與來源一致**） |
| `GPSSpeed` + `GPSSpeedRef`      | RMC 速度（節 → 換算後配合 Ref）                   |
| `GPSTrack` + `GPSTrackRef`      | RMC 航向（對地行進方向）                          |
| `GPSImgDirection`               | 因鏡頭朝車輛前方，預設與 `GPSTrack` 同值              |


若有可靠水平誤差估計且工具支援，可填 `**GPSHPositioningError`**；無則省略。

### 4.2 EXIF 主影像區


| 標籤                                | 用途                    |
| --------------------------------- | --------------------- |
| `DateTimeOriginal` / `CreateDate` | 寫入**當地拍攝時間**          |
| `OffsetTimeOriginal`              | 寫入當地時區偏移（例如 `+09:00`） |
| `Software`                        | 註明轉檔工具名稱與版本           |
| `Make` / `Model`                  | 若已知行車記錄器型號可填          |


- **時間策略明確化**：`GPSDateStamp` / `GPSTimeStamp` 一律寫 **UTC**；`DateTimeOriginal` / `CreateDate` 一律寫 **當地時間**，避免相簿與地圖軟體解讀錯誤。

### 4.3 XMP（實作方針）

- **不寫入 XMP**：寫檔時以 ExifTool **`-XMP:all=`** 移除全部 XMP，避免部分平台（如 Panoramax）優先讀 XMP 而誤解析時間。
- **EXIF 時區**：除 `OffsetTimeOriginal`／`OffsetTimeDigitized` 外，另寫 **`OffsetTime`**（與 `--offset` 相同），與 `DateTimeOriginal`／`CreateDate` 之牆上時間搭配。

## 5. 實作階段

1. **NMEA 解析模組**：輸出結構化陣列（UTC、座標、速度、航向、GGA 延伸欄位）；處理 checksum、無效 `V` 狀態。
2. **曆元合併**：以 UTC 為鍵，合併 RMC + 最近 GGA + 選定 GSA（PDOP/HDOP/VDOP）；最近鄰合併需設定最大容忍差（建議 `<= 1.0s`），超過則該欄位留空並標記品質降級。
3. **時間軸**：讀取 `UTC0` 與可選 **`gps_offset`（整數）**；產生每筆輸出之 `t_base` 與位移後之 RMC。
4. **截圖**：依 **3.1 節**之 `frame_index`（由 `t_base`）決定畫面，再以 ffmpeg 或 filter 批次輸出；檔名包含**當地牆上時間**、**與 `--offset` 相同之時區後綴**與 frame index，例如 `2026-04-03T10-35-46+0900_f00000.jpg`。
5. **寫入 metadata**：依對照表寫 EXIF／XMP；跑一小批用 **ExifTool 讀回**或地圖軟體驗證。
6. **疊字比對（可選）**：若需與行車記錄器畫面內建 GPS／時間疊字對照，使用 **校正模式**（`--sample-duration` 限制筆數，或**不帶** `--sample-duration` 且帶 **`--sample-step`** 之全片）並 **+ NMEA**：在 JPEG **左下角另**標註該幀之 **UTC／本地時間**與 **WGS84**（小數 **8** 位）；底色僅包住文字區塊。**EXIF GPS 與一般模式相同**；一般模式**不**疊圖。  
7. **驗收**：地圖上疊點、抽樣 3～5 張與路段比對；檢查首尾幀與 NMEA 最後幾秒是否越界，並確認 **`gps_offset` 已固定**。

## 6. 風險與待決事項


| 項目               | 說明                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| RMC 與 GGA 時間差    | 合併時採「絕對時間差最小」並記錄於 sidecar 或 EXIF 註解                                                                                                               |
| `$GSENSORD` 筆數較少 | 不與每秒強制 1:1；僅在有資料時寫入或內插                                                                                                                            |
| 影片經重新封裝          | 已見 Lavf，若來源曾轉檔，**仍以 NMEA 與檔名錨定**為主                                                                                                                |
| GSV 資料量          | 預設不寫入 EXIF，避免過大與相容性問題                                                                                                                             |
| **實作與 3.1 節一致**  | 若計畫要求「以 frame index 為準、不以單純 `-ss` 取代」，截圖程式應改為 **filter `select=eq(n\,…)`** 或 **先 `ffprobe` 列出每幀 `best_effort_timestamp_time` 再對應 seek**，並與本文件一併驗收 |


## 7. 參考檔名

- 開發時曾用配對檔名例如 `FILE260403-103546F.mp4`／`.NMEA` 驗證；實際使用時請自行備妥影片與 NMEA，**不納入版本庫**。

## 8. Panoramax 對齊（參考 [OSM Diary：Converting dash cam videos into Panoramax images](https://www.openstreetmap.org/user/FeetAndInches/diary/408268)）

日記作者以 **Garmin** 為例，從 **MP4 內嵌 GPS**（`exiftool -ee3`）取軌跡；本專案為 **NMEA 側檔**，差異在於「軌跡來源」，上傳前對 **JPEG** 的欄位要求仍可對照下列項目調整本計畫。

### 8.1 上傳前建議具備的欄位

- **必填（日記明列）**：`GPSLatitude`、`GPSLongitude`、`GPSLatitudeRef`、`GPSLongitudeRef`、`DateTimeOriginal`（時間字串需讓 ExifTool／Panoramax 正確解析；日記以 **ISO 8601** 寫入為例）。
- **強烈建議**：
  - `**SubSecTimeOriginal`**：當 **同一秒內有多張圖**（例如 15 fps 下改為「每幀」或短間隔輸出）時，`DateTimeOriginal` **通常無法**保存小數秒，序列在平台上可能**順序錯亂**；應依該幀的實際時間寫入小數秒對應欄位（日記說明為**整數字串**，對應秒的小數部分）。若維持 **1 Hz 一張**且時間皆落在**整秒**，可填 `000` 或依實測省略。
  - `**Make` / `Model`**：日記指出有助於 **Panoramax 顯示裝置資訊與 GPS 品質／評分**。
  - `**Artist`（或 Author）**：便於歸屬與分享。
- **與本計畫 4.2 節呼應**：`GPSDateStamp`／`GPSTimeStamp` 維持 **UTC**；`DateTimeOriginal`／`CreateDate` 寫 **當地時間**並搭配 `**OffsetTimeOriginal`**。日記亦說明若未標時區，**Panoramax 會假設為本地時間再轉 UTC**，故**偏移欄位應寫清楚**，避免與 UTC 欄位混淆。

### 8.2 與日記「步驟 2」的差異

日記在軌跡上再做 **約 3 m 等距內插**，是因為從影片抽出的 GPS 點較稀疏、需補點以控制密度。**本專案已有完整 NMEA 軌跡**（與影片對時後，每筆 RMC／對應幀皆有明確座標），**不需要**再做沿距離內插；輸出密度由 **§3.1（每 RMC 一張等）** 決定即可。

### 8.3 ffmpeg 與品質

日記以 `**-ss <秒> -i … -q:v 3`** 為例（偏省空間）。**本計畫以畫質為優先**：MJPEG 輸出預設 `**-q:v 1`**（數字越小畫質越好、檔案越大；範圍通常 1～31）。若需縮檔再上傳，可改 `**-q:v 2`～`3**` 或事後用壓縮工具。**3.1 節**若以 **幀索引** 為準，`-ss` 僅為實作選項之一。

---

*文件版本：依目前 ffprobe／NMEA 檢視結果整理；實作時若換機型或韌體，應重新抽樣確認幀率與 NMEA 週期。*

*Panoramax 欄位與流程參考：FeetAndInches，OpenStreetMap Diary 408268（2026-02-20）。*