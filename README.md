# mio-dashcam-mp4-to-jpg

處理 MIO 行車記錄器的 NMEA / MP4 檔案，依 NMEA 點位擷取 JPEG 並寫入 **EXIF GPS** 等 metadata 欄位。

## 需求

- **Node.js** 20 以上  
- **ffmpeg**、**ffprobe**（需在 `PATH` 內）  
- 安裝後會透過 npm 取得 **ExifTool**（`exiftool-vendored`）與 **sharp**（校正模式疊印；**`--crop`** 裁切亦使用）

## 安裝

```bash
cd mio-dashcam-mp4-to-jpg
npm install
```

## 使用

以下範例以配對檔 **`FILE260403-103546F.mp4`**／**`FILE260403-103546F.NMEA`** 為例（請換成你的檔名）。

### 一般模式

每筆有效 GPS RMC 點位輸出一張圖，將 GPS 資訊寫入 EXIF 欄位。

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F \
  --offset +09:00 \
  --make Mio \
  --model "MiVu 868W"
```

（亦可省略 **`--out`**，等同 **`./_out/FILE260403-103546F`**。）

### 校正模式

- 命令列帶有 `--sample-duration` 或 `--sample-step` 等參數時，進入校正模式，在 JPEG **左下角** 另印上 **`t`、UTC、本地時間、WGS84** 資訊。

**範例（前 5 筆錨點、幀位移）：**

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F/calibrate \
  --sample-duration 5 \
  --sample-step 1 \
  --offset +09:00 \
  --frame-offset 7 \
  --crop 2560x1355 \
  --make Mio \
  --model "MiVu 868W"
```

**範例（全片、每隔 2 筆 GPS RMC 取一錨點）：**

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F/sparse \
  --sample-step 2 \
  --offset +09:00 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"
```

## 輸出目錄

- **未指定 `--out`** 時，預設寫入 **`./_out/<MP4 主檔名>/`**（主檔名＝不含副檔名，例如 `FILE260403-103546F.mp4` → `./_out/FILE260403-103546F/`）。

### 主要選項

| 選項 | 說明 |
|------|------|
| `--video` | 影片路徑（H.264 MP4 等） |
| `--nmea` | NMEA 文字檔 |
| `--out` | 輸出目錄；**省略**時為 **`./_out/<MP4 主檔名>/`** |
| `--gps-offset` | 整數 **N**；擷取幀不變，**GPS／EXIF** 改用錨點 RMC 在軌跡上前／後第 **N** 筆（`-1`＝更早一筆） |
| `--frame-offset` | 整數；在依 `t_base` 算出的 **frame_index** 上加 **N** 幀（預設 `0`）。正數寫 **`5`**，負數寫 **`-3`**；結果小於 **0** 會視為 **0**，大於 **maxFrame** 則略過該張。例：`5` 則原本 f15→f20 |
| `--crop` | **`<寬>x<高>`**（例：`--crop 2560x1355`）；擷取後自**左上角 (0,0)** 裁出該寬高矩形（預設不裁）。若寬或高大於圖面，則裁至圖內並警告。 |
| `--offset` | 當地時區，例如 `+09:00`；用於 `DateTimeOriginal`／`OffsetTimeOriginal`（預設 `+09:00`） |
| `--jpeg-quality` | MJPEG `-q:v`，**1** 畫質最佳（預設 **1**） |
| `--gga-max-delta-ms` | 與 `$GNGGA` 合併的最大時間差（預設 **1000** ms），超過則不寫海拔／HDOP |
| `--make` / `--model` / `--artist` | 選填，寫入 EXIF（Panoramax 等較友善） |
| `--sample-duration` | **校正**：有設定時最多輸出 **`N` 筆**（整數≥1）；依 **`--sample-step`** 走 RMC 索引，先略過 `t_base < sample-start` 的錨點，再依序收錄。**須 `--nmea`**（另疊字；EXIF 與一般模式相同） |
| `--sample-start` | 校正：以 **`t_base`（秒）** 篩掉開頭錨點（預設 `0`）；與 **`--sample-duration`** 搭配時，從第一個 **`t_base ≥ sample-start`** 的錨點起算筆數 |
| `--sample-step` | **校正**：**RMC 軌跡索引間隔**（整數 **N≥1**，預設 **1**）。依 `rmcList` 取 `i = 0, N, 2N, …`。**全片校正**時必須在命令列出現本參數（例如 `--sample-step 2`） |
| `--help` | 顯示說明 |

## 輸出檔名

一般模式：`YYYY-MM-DDTHH-mm-ssZ_f#####.jpg`

校正模式：`calibrate_f#####_t*.***s.jpg`（檔名含 frame index 與 t_base）。

## 校正建議

1. 使用 **校正模式**（**`--sample-duration`** 限制筆數，或全片僅 **`--sample-step`**）輸出 JPEG，對疊字試 **`--gps-offset`**（見上節）。  
2. 可搭配 **`--frame-offset`** 微調實際擷取之幀；**`--crop`** 自左上裁切畫面範圍。  
3. 檢視輸出 JPEG 的 **EXIF**（UTC、座標）與畫面是否一致。  
4. **`--offset`** 請與拍攝地**時區**一致（例如日本為 `+09:00`）。

## 指令範例

```bash
node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F \
  --offset +09:00 \
  --jpeg-quality 3 \
  --make Mio \
  --model "MiVu 868W"

node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F/calibrate \
  --sample-duration 5 \
  --sample-step 1 \
  --offset +09:00 \
  --jpeg-quality 3 \
  --frame-offset 7 \
  --crop 2560x1355 \
  --make Mio \
  --model "MiVu 868W"

node extract.js \
  --video ./FILE260403-103546F.mp4 \
  --nmea ./FILE260403-103546F.NMEA \
  --out ./_out/FILE260403-103546F/calibrate-full \
  --sample-step 2 \
  --offset +09:00 \
  --jpeg-quality 3 \
  --frame-offset 7 \
  --make Mio \
  --model "MiVu 868W"
```

## 授權

本工具以 MIT License 授權。
