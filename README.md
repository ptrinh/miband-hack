# MiBand Hack

Webapp để **sideload app (.rpk) và watchface (.bin) lên Mi Band 8 / 9 / 10 ngay từ trình duyệt** trên macOS, Windows, Linux. Không cần cài phần mềm, không cần điện thoại Android.

> Dự án độc lập, không liên kết với Xiaomi. Giao thức được port từ [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) (AGPL-3.0).

**👉 Dùng ngay: <https://miband.trinh.uk>** · [Hướng dẫn sử dụng](docs/HUONG-DAN.md) · [Hướng dẫn phát triển](CONTRIBUTING.md)

## Vì sao làm

Tính đến 10/2026, các cách sideload hiện có đều buộc phải cài phần mềm:

| Công cụ | Nền tảng | Ghi chú |
|---|---|---|
| Notify for Xiaomi | Android | App trả phí, có tab cài app bên thứ ba |
| Gadgetbridge | Android | Mã nguồn mở, có RpkService |
| AstroBox-NG | Win / Linux / Android / iOS (app native) | Core Rust, app Tauri là mã đóng, chưa có bản web công khai |

MiBand Hack lấp chỗ trống đó: mở một trang web là cài được.

## Hỗ trợ

| Thiết bị | Kết nối | API trình duyệt | Trạng thái |
|---|---|---|---|
| Mi Band 9, 10, 9 Pro, 10 Pro | Bluetooth Classic (SPP) | Web Serial (Chrome/Edge ≥ 117, desktop) | Đã có code, chưa thử trên máy thật |
| Mi Band 9 Active | BLE V2 (`fe95` / `005e`, `005f`) | Web Bluetooth | Đã có code, chưa thử trên máy thật |
| Mi Band 8 | BLE V1 (`fe95` / `0051`–`0055`) | Web Bluetooth | Đã có code, chưa thử trên máy thật |

- Định dạng: `.rpk` (Vela quick app), watchface v2 (header `5A A5`). Watchface v3 và firmware **cố ý không hỗ trợ** (firmware dễ gây brick).
- Trình duyệt: Chrome hoặc Edge bản desktop. Safari/Firefox không có Web Serial/Web Bluetooth.
- Linux: có thể cần bật `chrome://flags/#enable-experimental-web-platform-features`.

## Cách dùng

1. **Lấy auth key**: bấm *"Lấy tự động bằng tài khoản Xiaomi"* rồi quét mã QR bằng điện thoại đã đăng nhập Xiaomi. Nếu không ra key, xem [hướng dẫn của Gadgetbridge](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).
2. **Tắt Bluetooth trên điện thoại** để band rảnh kết nối.
3. Mi Band 9/10: **ghép (pair) band** trong phần cài đặt Bluetooth của hệ điều hành trước.
4. Mở webapp → nhập key → **Kết nối** → kéo thả file `.rpk` → **Cài lên band**.

## App mẫu (bấm Add là cài)

| App | Mô tả | Mã nguồn |
|---|---|---|
| Calculator | Máy tính + − × ÷, số thập phân | `demo-apps/calculator` |
| Drawing | Vẽ bằng tay: 5 màu, 3 cỡ bút, tẩy, hoàn tác, tự lưu | `demo-apps/drawing` |
| Notes | Hiện note của người dùng (chỉ xem). Note soạn trên webapp, trình duyệt **đóng gói lại và ký lại `.rpk`** rồi cài | `demo-apps/notes` + `src/rpk/` |
| Snake | Game rắn săn mồi: vuốt hoặc chạm nửa trái/phải để rẽ, nhanh dần, lưu điểm cao nhất | `demo-apps/snake` |
| SAT Flashcards | Học 372 từ vựng SAT: lật thẻ, Know it / Again, ôn lặp ngắt quãng (hộp Leitner), tiến độ lưu trên band | `demo-apps/sat-flashcards` |

Ngoài catalog: **Phone Remote** (`demo-apps/phone-remote`) — bấm trên band để chụp ảnh, chuyển slide, play/pause trên điện thoại. Cần app Android đi kèm (cùng package, cùng chữ ký) và Mi Fitness để chuyển tin nhắn qua `system.interconnect`; chưa kiểm chứng trên Mi Band 9/10 nên chưa đưa vào catalog.

Cả năm app trong catalog build bằng `aiot-toolkit` 2.0.5 (toolchain chính thức của Xiaomi Vela). **Chưa app nào được chạy thử trên band thật.**

`src/rpk/` là bản port định dạng chữ ký "RPK Sig Block 42" của aiot-toolkit (biến thể APK Signature Scheme v2, RSA PKCS#1 v1.5 + SHA-256) sang WebCrypto. Test xác nhận chữ ký **giống từng byte** với bản toolkit ký. Notes được ký bằng một key demo **cố ý công khai** (`src/rpk/demo-key/`).

## Lấy key bằng QR: cách hoạt động

`worker/xiaomi-cloud.ts` là bản port luồng đăng nhập QR của [Xiaomi Cloud Tokens Extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) (MIT):
`/api/xiaomi/qr` tạo mã QR, sau đó `/api/xiaomi/poll` long-poll tới khi người dùng quét, lấy service token, liệt kê thiết bị và gọi `blt_get_beaconkey`.
Phiên đăng nhập (`ssecurity`/`serviceToken`) chỉ tồn tại trong một request của Worker, không trả về trình duyệt, không lưu, observability tắt.
Cần proxy vì API của Xiaomi không cho trình duyệt gọi thẳng (chặn CORS).

> **Chưa kiểm chứng:** key lấy từ cloud Mi Home có đúng là auth key của Mi Band hay không (beaconkey của cảm biến BLE thường chỉ dài 24 hex). UI cảnh báo nếu key không đủ 32 hex.

## Deploy

Một Worker phục vụ cả trang tĩnh (`dist/`) lẫn `/api/*`, gắn custom domain `miband.trinh.uk`:

```bash
echo 'CLOUDFLARE_ACCOUNT_ID=<id của bạn>' > .env   # Wrangler tự đọc file này, file đã gitignore
npm run deploy
```

Muốn deploy lên domain khác thì sửa `routes` trong `wrangler.jsonc`.

Trang là PWA (manifest + service worker): người dùng bấm "Cài thành ứng dụng" để có icon riêng, mở được cả khi offline (trừ bước lấy key).

## Phát triển

```bash
npm install
npm run dev        # http://localhost:5173 (Web Serial/Bluetooth chạy được trên localhost)
npm run dev:worker # chạy cả Worker (/api/xiaomi/*) tại http://localhost:8787
npm test           # unit test + test tích hợp với band giả lập
npm run build      # build tĩnh ra dist/, deploy lên host HTTPS bất kỳ
```

### Cấu trúc

```
src/
  core/        bytes, checksum (CRC16/ARC, CRC32), crypto (AES-CCM tự viết, AES-CTR, HMAC),
               auth (bắt tay miwear-auth), proto (protobuf subset), packets (SPP V1/V2), files (.rpk/.bin)
  transport/   serial.ts (Web Serial → RFCOMM SPP), ble.ts (Web Bluetooth, tự nhận BLE V1/V2)
  protocol/    stream-link.ts (SPP V1/V2 + sliding window, dùng cho cả SPP và BLE V2),
               ble-v1-link.ts (giao thức chunk của Mi Band 8)
  device.ts    xác thực, thông tin máy, danh sách app/watchface, cài đặt (DataUpload)
  main.ts      giao diện (gồm catalog "App mẫu" đọc từ public/apps/catalog.json)
worker/        Cloudflare Worker: phục vụ trang + API lấy key bằng QR Xiaomi
demo-apps/     mã nguồn app mẫu (Calculator)
test/
  core.test.ts         crypto đối chiếu với node:crypto, vector frame/protobuf, parse file
  fake-band.ts         band giả lập (crypto phía band dùng node:crypto, độc lập với code chính)
  integration.test.ts  dò phiên bản → SPP V2 → xác thực → cài .rpk đầu cuối
```

Chi tiết giao thức: [docs/protocol.md](docs/protocol.md).

## Việc tiếp theo

- [ ] Thử trên Mi Band 9/10 thật qua Web Serial ở cả macOS, Windows, Linux (rủi ro lớn nhất, xem phần "Rủi ro" trong docs).
- [ ] Thử Mi Band 8 và tinh chỉnh kích thước ghi BLE (mặc định 180 byte).
- [ ] Kho app/watchface (catalog + tìm kiếm + cài một chạm).
- [ ] i18n (English / 中文).
- [ ] Xác nhận key lấy bằng QR dùng được cho Mi Band. Nếu không, tìm API của Mi Fitness.

## Giấy phép

AGPL-3.0-or-later, vì phần giao thức là bản port từ Gadgetbridge (AGPL-3.0). Luồng đăng nhập Xiaomi port từ Xiaomi Cloud Tokens Extractor (MIT). Xem [LICENSE](LICENSE).
