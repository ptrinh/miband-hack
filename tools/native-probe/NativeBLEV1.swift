import Foundation
import CoreBluetooth

// JSON-lines pipe to v1-test.ts: a generic FE95 GATT client (notify on every characteristic, write by UUID).
func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var out = fields
    out["event"] = event
    if let data = try? JSONSerialization.data(withJSONObject: out) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

final class Client: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    let match: String
    var central: CBCentralManager!
    var peripheral: CBPeripheral?
    var chars: [String: CBCharacteristic] = [:]
    var subscribing: [CBCharacteristic] = []
    // Writes with response complete in order per characteristic.
    var pendingIds: [String: [Int]] = [:]
    // Writes without response wait for CoreBluetooth's flow control.
    var queued: [(id: Int, c: CBCharacteristic, data: Data)] = []
    var finishing = false

    init(match: String) {
        self.match = match.lowercased()
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }
    func fail(_ phase: String, _ error: Error?) {
        let e = error as NSError?
        emit("error", ["phase": phase, "message": e?.localizedDescription ?? "", "code": e?.code ?? -1])
        finish()
    }
    func finish() {
        guard !finishing else { return }
        finishing = true
        central.stopScan()
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(0) }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        emit("adapter", ["state": central.state.rawValue, "authorization": CBManager.authorization.rawValue])
        guard central.state == .poweredOn else { return }
        // A band already connected to this Mac (e.g. by the OS) does not advertise.
        let known = central.retrieveConnectedPeripherals(withServices: [CBUUID(string: "FE95")])
        if let p = known.first(where: { ($0.name ?? "").lowercased().contains(match) }) {
            emit("found", ["name": p.name ?? "", "already_connected": true])
            connect(p); return
        }
        central.scanForPeripherals(withServices: nil, options: nil)
        emit("scanning", ["match": match])
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            if self.peripheral == nil { emit("not_found"); self.finish() }
        }
    }
    func connect(_ p: CBPeripheral) {
        central.stopScan()
        peripheral = p
        p.delegate = self
        central.connect(p, options: nil)
    }
    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard peripheral == nil else { return }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        guard name.lowercased().contains(match) else { return }
        emit("found", ["name": name, "rssi": RSSI])
        connect(p)
    }
    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        emit("connected")
        p.discoverServices([CBUUID(string: "FE95")])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { fail("connect", error) }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        emit("disconnected", ["message": (error as NSError?)?.localizedDescription ?? ""])
        finish()
    }
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let s = p.services?.first(where: { $0.uuid == CBUUID(string: "FE95") }) else { fail("services", error); return }
        p.discoverCharacteristics(nil, for: s)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { fail("characteristics", error); return }
        let list = service.characteristics ?? []
        for c in list { chars[c.uuid.uuidString.lowercased()] = c }
        emit("characteristics", ["items": list.map { ["uuid": $0.uuid.uuidString.lowercased(), "properties": $0.properties.rawValue] as [String: Any] }])
        emit("ready", ["name": p.name ?? "", "maxWrite": p.maximumWriteValueLength(for: .withResponse), "maxWriteNoResponse": p.maximumWriteValueLength(for: .withoutResponse)])
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        guard let id = subscribeIds.removeValue(forKey: c.uuid.uuidString.lowercased()) else { return }
        if let e = error { emit("done", ["id": id, "error": e.localizedDescription]) } else { emit("done", ["id": id]) }
    }
    var subscribeIds: [String: Int] = [:]
    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard error == nil, let value = c.value else { return }
        emit("data", ["uuid": c.uuid.uuidString.lowercased(), "base64": value.base64EncodedString()])
    }
    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        let key = c.uuid.uuidString.lowercased()
        guard var ids = pendingIds[key], !ids.isEmpty else { return }
        let id = ids.removeFirst()
        pendingIds[key] = ids
        if let e = error { emit("done", ["id": id, "error": e.localizedDescription]) } else { emit("done", ["id": id]) }
    }
    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) { flush() }
    func flush() {
        guard let p = peripheral else { return }
        while !queued.isEmpty && p.canSendWriteWithoutResponse {
            let w = queued.removeFirst()
            p.writeValue(w.data, for: w.c, type: .withoutResponse)
            emit("done", ["id": w.id])
        }
    }
    func command(_ o: [String: Any]) {
        let op = o["op"] as? String ?? ""
        if op == "close" { finish(); return }
        let id = o["id"] as? Int ?? -1
        guard let p = peripheral, let uuid = (o["uuid"] as? String)?.lowercased(), let c = chars[uuid] else {
            emit("done", ["id": id, "error": "unknown characteristic"]); return
        }
        if op == "notify" {
            subscribeIds[uuid] = id
            p.setNotifyValue(true, for: c)
        } else if op == "write", let s = o["base64"] as? String, let data = Data(base64Encoded: s) {
            if o["response"] as? Bool == true {
                pendingIds[uuid, default: []].append(id)
                p.writeValue(data, for: c, type: .withResponse)
            } else {
                queued.append((id, c, data))
                flush()
            }
        } else {
            emit("done", ["id": id, "error": "bad op"])
        }
    }
}

let client = Client(match: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "band 8")
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async { client.command(obj) }
    }
    DispatchQueue.main.async { client.finish() }
}
RunLoop.main.run()
