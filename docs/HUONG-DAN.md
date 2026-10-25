# Hướng dẫn sử dụng MiBand Hack

Cài app và mặt đồng hồ cho **Xiaomi Smart Band 8 / 9 / 10** ngay trên máy tính, không cần cài phần mềm.

👉 **Mở: <https://miband.trinh.uk>**

> ⚠️ Dự án cộng đồng, không phải của Xiaomi. App cài ngoài có thể làm band chạy chập chờn. Nếu có chuyện, gỡ app đó hoặc khởi động lại band.

---

## Bạn cần gì

| | |
|---|---|
| 💻 Máy tính | Windows, macOS hoặc Linux, có Bluetooth |
| 🌐 Trình duyệt | **Google Chrome** hoặc **Microsoft Edge** (Safari và Firefox **không** dùng được) |
| ⌚ Band | Mi Band 8, 9, 9 Pro, 9 Active, 10, 10 Pro, **đã ghép với app Mi Fitness** trên điện thoại |
| 📱 Điện thoại | Để quét mã QR lấy "chìa khoá" của band |

---

## Bước 1: Lấy chìa khoá (auth key) của band

Mỗi chiếc band có một chìa khoá riêng do Xiaomi cấp. Không có chìa khoá thì máy tính không nói chuyện được với band.

1. Trên trang web, bấm nút cam **"Chưa có key? Lấy tự động bằng tài khoản Xiaomi"**.
2. Một mã QR hiện ra. Dùng điện thoại **đã đăng nhập đúng tài khoản Xiaomi đang ghép với band** để quét (ví dụ app Xiaomi Home / Mi Home).
3. Xác nhận đăng nhập trên điện thoại.
4. Vài giây sau, danh sách thiết bị hiện ra. Bấm **"Dùng key này"** ở dòng chiếc band của bạn.
5. Tick **"Ghi nhớ trên trình duyệt này"** để lần sau khỏi làm lại.

**Không thấy band trong danh sách?**
- Thử chọn đúng **Khu vực tài khoản** (Việt Nam thường là *Singapore*) rồi bấm lại.
- Nếu vẫn không được: mở mục *"Cách khác để lấy auth key"* trên trang, hoặc nhờ người rành máy tính giúp theo [hướng dẫn của Gadgetbridge](https://gadgetbridge.org/basics/pairing/huami-xiaomi-server/).

> 🔒 Trang không bao giờ hỏi mật khẩu Xiaomi của bạn. Phiên đăng nhập chỉ dùng một lần để đọc chìa khoá rồi bỏ đi, không lưu lại.

**Đừng** bấm "huỷ ghép / unpair" band trong Mi Fitness, và đừng reset band, vì làm vậy chìa khoá sẽ đổi và phải lấy lại.

---

## Bước 2: Kết nối band

1. **Tắt Bluetooth trên điện thoại**: mỗi lúc band chỉ nói chuyện được với một thiết bị.
2. Bấm nút phù hợp với band của bạn:

| Band của bạn | Bấm nút | Chuẩn bị trước |
|---|---|---|
| Mi Band **9, 10, 9 Pro, 10 Pro** | **Mi Band 9 / 10 / 9 Pro / 10 Pro** | Vào cài đặt Bluetooth của máy tính, **ghép (pair) với band** trước |
| Mi Band **8**, **9 Active** | **Mi Band 8 / 9 Active…** | Không cần |

3. Trình duyệt hiện một hộp thoại:
   - Mi Band 9/10: chọn dòng có chữ **"Bluetooth SPP"** hoặc tên band → **Kết nối**.
   - Mi Band 8: chọn tên band (ví dụ *Xiaomi Smart Band 8 XXXX*) → **Ghép nối**.
4. Khi thấy chấm xanh **"Đã kết nối"** cùng tên model và % pin là xong.

---

## Bước 3: Cài app

**Cách nhanh nhất:** ở mục **"App mẫu"**, bấm **Add** cạnh app bạn muốn (ví dụ *Calculator*). Đợi thanh tiến độ chạy hết là xong, app sẽ hiện trong danh sách ứng dụng trên band.

**App Notes (note của riêng bạn):** bấm **Edit notes / Sửa note** cạnh app Notes, gõ tiêu đề và nội dung từng note (thêm bao nhiêu cũng được), rồi bấm **Add**. Trên band: danh sách note → bấm vào để đọc → nút **Back** để quay lại. Muốn đổi nội dung thì sửa lại trên trang rồi bấm **Add** lần nữa. Note được lưu trên trình duyệt của bạn.

**Đổi ngôn ngữ:** nút **EN · 中文 · VI** ở góc trên.

**Cài file của riêng bạn:** kéo thả file `.rpk` (app) hoặc `.bin` (mặt đồng hồ) vào ô **"Hoặc cài file của bạn"**, rồi bấm **Cài lên band**.

**Gỡ app / đổi mặt đồng hồ:** dùng danh sách **"App trên band"** và **"Watchface"** ở cuối trang.

---

## Cài thành ứng dụng trên máy tính (tuỳ chọn)

Bấm nút **"Cài thành ứng dụng"** ở góc trên, hoặc biểu tượng cài đặt ở thanh địa chỉ của Chrome. Bạn sẽ có icon MiBand Hack trên desktop như một phần mềm bình thường.

---

## Gặp lỗi?

| Hiện tượng | Cách xử lý |
|---|---|
| Nút kết nối bị mờ | Bạn đang dùng Safari/Firefox → mở bằng Chrome hoặc Edge |
| Không thấy band trong hộp thoại | Tắt Bluetooth điện thoại. Mi Band 9/10: kiểm tra đã pair trong cài đặt Bluetooth của máy tính chưa. Linux: bật `chrome://flags/#enable-experimental-web-platform-features` |
| "Sai auth key" | Lấy lại key ở Bước 1, chọn đúng dòng của band |
| "Hết thời gian xác thực" | Điện thoại vẫn đang giữ kết nối với band → tắt hẳn Bluetooth điện thoại rồi thử lại |
| "Band từ chối cài app" | App không hợp với đời band này |
| Cài xong band chạy lạ | Gỡ app vừa cài trong danh sách "App trên band", hoặc khởi động lại band |

Vẫn không được? Mở mục **"Nhật ký kết nối"** ở cuối trang, chụp màn hình và [tạo issue trên GitHub](https://github.com/ptrinh/miband-hack/issues).
