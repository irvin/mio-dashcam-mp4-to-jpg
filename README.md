# mio-dashcam-convert

依 **NMEA** 與 **MP4** 對時，擷取 JPEG 並寫入 **EXIF GPS** 與時間欄位。流程與假設見同資料夾 **[PLAN.md](./PLAN.md)**。

## 需求

- **Node.js** 20 以上  
- **ffmpeg**、**ffprobe**（需在 `PATH` 內）  
- 安裝後會透過 npm 取得 **ExifTool**（`exiftool-vendored`）與 **sharp**（**校正模式**疊印時間／WGS84 用）

## 安裝

```bash
cd mio-dashcam-convert
npm install
```

## 使用

以下範例以配對檔 **`FILE260403-103546F.mp4`**／**`FILE260403-103546F.NMEA`** 為例（請換成你的檔名）。

### 一般模式

每筆有效 **RMC** 曆元輸出一張（未帶下方「校正」條件時進入此模式）。**不**在圖上疊字，metadata 僅在 EXIF。

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test_full \
  --offset +09:00 \
  --make Mio \
  --model "MiVu 868W"
```

### 校正模式

**須**同時提供 **`--nmea`**。在 JPEG **左下角**另疊 **`t`、UTC、本地時間、WGS84**（與一般模式相同之 **EXIF GPS** 仍會寫入）。

進入條件（擇一）：

- 有 **`--sample-duration`**：自 **`t_base ≥ --sample-start`** 起，依 **`--sample-step`** 掃 RMC，**最多輸出 N 筆**（成功寫入之張數）。
- **未**帶 **`--sample-duration`**，且命令列有 **`--sample-step`**：**全片**依索引間隔抽樣。

**範例（前 5 筆錨點、幀位移、Make／Model）：**

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test \
  --sample-duration 5 \
  --sample-step 1 \
  --offset +09:00 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"
```

**範例（全片、每隔 2 筆 RMC 取一錨點）：**

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test_sparse \
  --sample-step 2 \
  --offset +09:00 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"
```

（全片校正時**勿**加 **`--sample-duration`**，且**須**帶 **`--sample-step`**。）

- **`--gps-offset`**：**不**改變擷取幀（仍依錨點之 `t_base` 與 **`--frame-offset`**）；只改 **EXIF／疊印** 用的 **RMC**（`錨點索引 i + N`）。`-1` 表示改用**更早一筆** GPS。決定後正式批次可再加 **`--gps-offset <N>`**。

### 主要選項

| 選項 | 說明 |
|------|------|
| `--video` | 影片路徑（H.264 MP4 等） |
| `--nmea` | NMEA 文字檔 |
| `--out` | 輸出目錄 |
| `--fps` | 幀率；預設 `15`；設為 `0` 時改用 ffprobe |
| `--gps-offset` | 整數 **N**；擷取幀不變，**GPS／EXIF** 改用錨點 RMC 在軌跡上前／後第 **N** 筆（`-1`＝更早一筆）。見 PLAN §2.3 |
| `--frame-offset` | 整數；在依 `t_base` 算出的 **frame_index** 上加 **N** 幀（預設 `0`）。正數寫 **`5`**，負數寫 **`-3`**；結果小於 **0** 會視為 **0**，大於 **maxFrame** 則略過該張。例：`5` 則原本 f15→f20 |
| `--offset` | 當地時區，例如 `+09:00`；用於 `DateTimeOriginal`／`OffsetTimeOriginal`（預設 `+09:00`） |
| `--jpeg-quality` | MJPEG `-q:v`，**1** 畫質最佳（預設 **1**） |
| `--gga-max-delta-ms` | 與 `$GNGGA` 合併的最大時間差（預設 **1000** ms），超過則不寫海拔／HDOP |
| `--make` / `--model` / `--artist` | 選填，寫入 EXIF（Panoramax 等較友善） |
| `--sample-duration` | **校正**：有設定時最多輸出 **`N` 筆**（整數≥1）；依 **`--sample-step`** 走 RMC 索引，先略過 `t_base < sample-start` 的錨點，再依序收錄。**須 `--nmea`**（另疊字；EXIF 與一般模式相同） |
| `--sample-start` | 校正：以 **`t_base`（秒）** 篩掉開頭錨點（預設 `0`）；與 **`--sample-duration`** 搭配時，從第一個 **`t_base ≥ sample-start`** 的錨點起算筆數 |
| `--sample-step` | **校正**：**RMC 軌跡索引間隔**（整數 **N≥1**，預設 **1**）。依 `rmcList` 取 `i = 0, N, 2N, …`。**全片校正**時必須在命令列出現本參數（例如 `--sample-step 2`） |
| `--help` | 顯示說明 |

## 輸出檔名

預設格式（PLAN §5）：

`YYYY-MM-DDTHH-mm-ssZ_f#####.jpg`

例：`2026-04-03T01-35-46Z_f00000.jpg`

校正模式另見 **`calibrate_f#####_t*.***s.jpg`**（檔名含 **frame index** 與 **`t_base`**）。

## 實作與 PLAN 的對應

- **幀選擇**：整數 fps 時 `frame_index = floor(t_base) * fps`（該曆秒**第一幀**）；非整數 fps 時 `floor(t_base × fps)`；再套用可選 **`--frame-offset`**。`t_base` 為該錨點 RMC 之影片時間；**EXIF GPS** 為 `rmcList[i + gpsOffset]`（一般模式與校正模式皆同）。  
- **截圖**：使用 ffmpeg **`select=eq(n\,…)+…`** **分批**輸出（每批至多 25 個 `eq`），以 **frame index** 為準（PLAN §3.1）。  
- **疊字比對**：僅**校正模式**且 **+ `--nmea`** 時以 **sharp** 在左下角疊 **時間 + WGS84**（**8** 位小數）；一般模式**不**疊圖。  
- **時間**：`GPSDateStamp`／`GPSTimeStamp` 為 **UTC**；`DateTimeOriginal`／`CreateDate` 為 **當地牆上時間**，並設 `OffsetTimeOriginal`；`SubSecTimeOriginal` 為該當地時間之毫秒（PLAN §4.2、§8.1）。  
- **GGA**：最近鄰合併，超過 **`--gga-max-delta-ms`** 則略過海拔／HDOP（PLAN §5）。  
- **畫質**：預設 `-q:v 1`（PLAN §8.3）。  
- **metadata**：由 **`buildExifTags`** 寫入；**XMP** 若需與 PLAN §4.3 完全同步，可再以 ExifTool 加寫。

## 校正建議（PLAN §2.3）

1. 使用 **校正模式**（**`--sample-duration`** 限制筆數，或全片僅 **`--sample-step`**）輸出 JPEG，對疊字試 **`--gps-offset`**（見上節）。  
2. 可搭配 **`--frame-offset`** 微調實際擷取之幀。  
3. 檢視輸出 JPEG 的 **EXIF**（UTC、座標）與畫面是否一致。  
4. **`--offset`** 請與拍攝地**時區**一致（例如日本多為 `+09:00`）。

## Panoramax／Mapillary

- 建議具備：緯經度與 Ref、`DateTimeOriginal`、時區偏移；可選 `Make`／`Model`／`Artist`、`SubSecTimeOriginal`。  
- 詳見 PLAN **§8** 與 [OSM Diary 408268](https://www.openstreetmap.org/user/FeetAndInches/diary/408268)。

## 本機測試並保留輸出（供檢視）

**請用真實行車記錄器配對檔**（同一段影片的 `.mp4` + `.NMEA`）產生 JPEG。輸出目錄 **`_test_run_output/`** 已列入 `.gitignore`，不會進版控。

```bash
mkdir -p _test_run_output

node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test_run_output \
  --offset +09:00 \
  --jpeg-quality 3 \
  --make Mio \
  --model "MiVu 868W"

node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test_run_output/calibrate \
  --sample-duration 5 \
  --sample-step 1 \
  --offset +09:00 \
  --jpeg-quality 3 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"

node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_test_run_output/calibrate-full \
  --sample-step 2 \
  --offset +09:00 \
  --jpeg-quality 3 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"
```

完成後：根目錄為含 EXIF 之 JPEG（約每個 RMC 曆元一張，例檔約 **120** 張）；`calibrate*` 目錄內為校正用樣本（**同樣寫 EXIF**，並**疊字**）。

## 授權

依專案根目錄授權；本工具 `package.json` 目前標示 `ISC`。
