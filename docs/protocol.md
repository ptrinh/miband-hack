# Giao thức Xiaomi Wear (Vela) — ghi chú khi port

Nguồn: Gadgetbridge (`app/src/main/java/.../service/devices/xiaomi/`, proto ở `GBProtobufGenerator/src/main/proto/xiaomi*.proto`), đọc ngày 25/10/2026. Tên class Java trong ngoặc.

## 1. Transport theo từng đời máy

| Thiết bị | `getConnectionType()` trong Gadgetbridge | Ở webapp |
|---|---|---|
| Mi Band 8 | BLE (mặc định) → BLE V1 | Web Bluetooth |
| Mi Band 9 Active | BLE → BLE V2 | Web Bluetooth |
| Mi Band 9 / 9 Pro / 10 / 10 Pro | `BT_CLASSIC` → SPP | Web Serial (RFCOMM, UUID `00001101-…`) |

## 2. SPP

Kết nối xong thì gửi **gói V1 hỏi phiên bản** (`badcfe 00 c0 0300 00 00 00 ef`). Nếu band trả `payload[0] >= 2` thì chuyển sang V2, nếu không thì dùng V1. Hết 5 giây không có trả lời cũng coi là V1 (`XiaomiSppSupport.handleVersionPacket`).

### SPP V1 (`XiaomiSppPacketV1`)
```
ba dc fe | ch(1) | flags(1: 0x80 flag, 0x40 needsResponse) | len(2 LE = payload+3) | opcode | serial | dataType | payload | ef
```
- Kênh gửi: version 0, proto TX 2, fitness 3, mass/data 5.
- `dataType`: 0 plain, 1 encrypted (AES-CCM), 2 auth.
- Kênh proto khi mã hoá: `u16 counter` + CCM(counter). Kênh data: CCM(counter 0), không có prefix counter.

### SPP V2 (`XiaomiSppPacketV2`, `XiaomiSppProtocolV2`)
```
a5 a5 | type(4 bit thấp) | seq | len(2 LE) | crc16/ARC(payload, 2 LE) | payload
```
- type: 0 NACK, 1 ACK, 2 SESSION_CONFIG, 3 DATA.
- Session config (op 1 = start request): TLV gồm version 1.0.0, max frame `0xfc00`, TX window 32, timeout 10000 ms. Band trả session config thì bắt đầu xác thực.
- DATA payload: `channel(1) | opcode(1) | body`. Channel 1 = proto/auth, 2 = data (upload), 5 = activity. Opcode 1 plain, 2 encrypted.
- Mã hoá V2: **AES-128-CTR với IV = key**, mỗi gói khởi động lại counter (đúng là như vậy, không phải nhầm).
- ACK tích luỹ, seq 8 bit quay vòng. NACK(n) nghĩa là band đang chờ gói n. Gửi lại sau 10 giây không có ack, 3 lần liên tiếp thì ngắt.
- Gadgetbridge đẩy các phần upload liên tục không chờ ack. Webapp tôn trọng TX window band gửi về (tối đa 32 frame đang bay).

## 3. BLE

### BLE V2 (`XiaomiBleProtocolV2`)
Dùng đúng framing SPP V2, chạy trên characteristic `0x005e` (notify, band→máy) / `0x005f` (write), service `0xfe95`. Gửi session config ngay, không hỏi phiên bản.

### BLE V1 (`XiaomiCharacteristicV1`)
Service `0xfe95`: `0051` command read, `0052` command write, `0053` activity, `0055` data upload.
- Gói điều khiển bắt đầu bằng `00 00`, byte 2 là type:
  - `0` chunked start `[00 00 00 enc u16 n]` → bên nhận trả `00 00 01 01`
  - `1` chunked ack: subtype 0 xong, 1 bắt đầu gửi chunk, 2 nack, 5 xin gửi lại chunk `[u16…]`
  - `2` single command `[00 00 02 enc(1=encrypted, 2=plain) (u16 counter) payload]` → ack `00 00 03 00`
  - `3` ack cho single command, byte 3 = 0 là OK
- Chunk dữ liệu: `u16 index (bắt đầu từ 1) | data`, kích thước ≤ write size − 2.
- Mã hoá V1: AES-CCM, tag 4 byte, nonce 12 byte = `nonce4 | 00000000 | u32 counter LE`. Upload dùng counter 0 (`incrementNonce=false`). Counter lệnh bắt đầu từ 1 sau khi xác thực.
- Web Bluetooth không xin được MTU, nên mặc định ghi 180 byte (macOS thường thoả thuận MTU khoảng 185).

## 4. Xác thực (`XiaomiAuthService`)
1. Máy → band: `Command{type 1, subtype 26, auth.appVerify.nonce = 16 byte ngẫu nhiên}`
2. Band → máy: `deviceVerify{nonce, hmac}`
3. `hk = HMAC-SHA256(key = phoneNonce‖watchNonce, msg = authKey)`, sau đó mở rộng kiểu HKDF-expand:
   `T(i) = HMAC(hk, T(i-1) ‖ "miwear-auth" ‖ i)`, lấy đủ 64 byte.
   `decKey = [0:16]`, `encKey = [16:32]`, `decNonce = [32:36]`, `encNonce = [36:40]`.
4. Kiểm tra `HMAC(decKey, watchNonce‖phoneNonce) == hmac`. Không khớp nghĩa là sai auth key.
5. Máy → band: `subtype 27, appConfirm{encryptedNonces = HMAC(encKey, phoneNonce‖watchNonce), encryptedDeviceInfo = CCM(encKey, CompanionDevice, counter 0)}`
6. Band trả subtype 27 thì xong, từ đây kênh proto được mã hoá.

## 5. Cài đặt
- **App**: `20/1 rpk.rpkInfo{id = package, unknown2 = versionCode, size}` → band trả `20/1 rpkInstallStart.cmd` (0 = OK) → DataUpload type **64** → band gửi `20/2` khi cài xong.
- **Watchface**: `4/4 watchfaceInstallStart{id, size}` → `installStatus` (0 OK, 2 đã có) → DataUpload type **16** → `4/1 watchfaceId` để đặt làm mặt đồng hồ.
- **DataUpload** (`XiaomiDataUploadService`): `22/0 dataUploadRequest{type, md5, size}` → `dataUploadAck{errno, resumePosition, chunkSize (mặc định 2048)}`.
  Payload = `00 | type | md5(16) | u32 size | bytes[resume:] | crc32(của tất cả phần trước)`, cắt thành từng phần `u16 total | u16 index(1-based) | data`, mỗi phần ≤ chunkSize.
- Danh sách: `20/0` app, `4/0` watchface. Xoá: `20/3 rpkDel{id, sha}`, `4/2 watchfaceId`.
- Thông tin máy: `2/2` deviceInfo, `2/1` battery.

## 6. Rủi ro / điều chưa kiểm chứng
- **Web Serial + Bluetooth Classic**: Chrome ≥ 117 hỗ trợ cổng RFCOMM trên desktop, nhưng thiết bị phải được pair sẵn ở tầng hệ điều hành. Chưa thử xem Mi Band 9/10 có cho pair trực tiếp với PC (ngoài Mi Fitness) và lộ dịch vụ SPP ra hay không. Đây là giả định quan trọng nhất cần kiểm chứng trên máy thật. AstroBox-NG nói đã làm được SPP trên Windows/macOS/Linux bằng native code, nên về mặt hệ điều hành là khả thi.
- Kích thước ghi BLE với Mi Band 8 khi không xin được MTU.
- Band có thể ngắt nếu không nhận được đồng bộ giờ hay các lệnh khởi tạo khác. Gadgetbridge có gửi `setCurrentTime` sau khi xác thực, webapp hiện chưa gửi.
