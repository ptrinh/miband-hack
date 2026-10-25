# Phát triển MiBand Hack

## Cài đặt

Cần **Node.js 22+** (khuyên dùng bản LTS mới nhất), Git, và Chrome/Edge.

```bash
git clone https://github.com/ptrinh/miband-hack.git
cd miband-hack
npm install
npm test            # phải ra "Tests 20 passed" trở lên
npm run dev         # mở http://localhost:5173
```

`localhost` được trình duyệt coi là an toàn, nên Web Serial và Web Bluetooth chạy được mà không cần HTTPS.

Muốn chạy cả phần lấy key bằng QR (`/api/xiaomi/*`, chạy trên Cloudflare Worker):

```bash
npm run dev:worker  # build rồi chạy Worker + trang tại http://localhost:8787
```

## Các lệnh

| Lệnh | Việc |
|---|---|
| `npm run dev` | Dev server có hot reload (chỉ frontend) |
| `npm run dev:worker` | Chạy Worker local qua `wrangler dev` |
| `npm test` | Vitest: crypto, packet, parser, band giả lập, ký request Xiaomi |
| `npm run typecheck` | TypeScript cho cả `src/` lẫn `worker/` |
| `npm run build` | Typecheck + build ra `dist/` |
| `npm run deploy` | Build + `wrangler deploy` (cần quyền Cloudflare, xem README) |

## Bản đồ code

```
src/
  main.ts              Giao diện (DOM thuần, không framework)
  device.ts            Điều phối: xác thực → thông tin máy → danh sách app → cài đặt
  core/
    auth.ts            Bắt tay "miwear-auth", dẫn khoá, AES-CCM (V1) / AES-CTR (V2)
    crypto.ts          AES-CCM tự viết (WebCrypto không có CCM), HMAC, MD5
    packets.ts         Đóng/mở frame SPP V1 và V2
    proto.ts           Schema protobuf rút gọn (số field giữ nguyên như Gadgetbridge)
    files.ts           Đọc .rpk (zip + manifest.json) và watchface .bin
  transport/
    serial.ts          Web Serial → Bluetooth Classic SPP (Mi Band 9/10)
    ble.ts             Web Bluetooth, tự nhận BLE V1 (Mi Band 8) hay V2 (9 Active)
  protocol/
    stream-link.ts     SPP V1/V2: dò phiên bản, sliding window, ack/nack, gửi lại
    ble-v1-link.ts     Giao thức chunk của Mi Band 8
  rpk/                 Đóng gói lại + ký lại .rpk trong trình duyệt (dùng cho Notes)
  i18n.ts              Từ điển EN / 中文 / VI và hàm t()
worker/
  index.ts             Phục vụ dist/ + API /api/xiaomi/qr, /api/xiaomi/poll
  xiaomi-cloud.ts      Đăng nhập QR Xiaomi, ký request RC4, lấy BLE key
public/apps/           App mẫu (catalog.json + .rpk) hiện trong mục "App mẫu"
demo-apps/             Mã nguồn các app mẫu
test/
  fake-band.ts         Band giả lập: phía band dùng node:crypto, độc lập với code chính
```

Tài liệu giao thức (rất nên đọc trước khi sửa `core/` hay `protocol/`): [docs/protocol.md](docs/protocol.md).

## Quy tắc

- **Mọi thay đổi giao thức phải có test.** Thêm trường hợp vào `test/fake-band.ts` nếu band giả lập cần làm thêm việc mới.
- Dữ liệu từ band hoặc từ file (tên app, manifest…) **chỉ được đưa vào DOM bằng `textContent`**, không bao giờ qua `innerHTML`.
- Không log và không lưu token Xiaomi ở Worker.
- Không thêm tính năng flash firmware (rủi ro brick band).

## Thử với band thật

1. Lấy auth key (nút QR trên trang, hoặc theo [Gadgetbridge](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/)).
2. Tắt Bluetooth điện thoại.
3. Mi Band 9/10: pair band trong cài đặt Bluetooth của hệ điều hành trước.
4. `npm run dev` → kết nối → xem **Nhật ký kết nối** trên trang và Console của DevTools.
5. Ghi lại hành vi lạ kèm log vào issue. Đặc biệt quan trọng: band có đi theo nhánh SPP V2 không, chunk size bao nhiêu, có NACK không.

## Thêm app mẫu

1. Đặt mã nguồn vào `demo-apps/<tên>/`, có README ghi cách build.
2. Copy file `.rpk` và icon vào `public/apps/`.
3. Thêm một mục vào `public/apps/catalog.json` (`description` có thể là chuỗi hoặc `{en, zh, vi}`).

Mỗi app mẫu có `node_modules` riêng khoảng 355 MB (aiot-toolkit). Build xong thì xoá đi nếu máy chật ổ đĩa.

## Thêm chữ cho giao diện

Mọi chữ hiển thị nằm trong `src/i18n.ts`, mỗi key phải có đủ 3 ngôn ngữ `en`, `zh`, `vi` (TypeScript báo lỗi nếu thiếu).
