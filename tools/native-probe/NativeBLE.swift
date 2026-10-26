import Foundation
import CoreBluetooth

// Private JSON-lines pipe to the driver; payloads must not be printed to user logs.
func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var out = fields
    out["event"] = event
    if let data = try? JSONSerialization.data(withJSONObject: out) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

final class Probe: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var candidates: [UUID: CBPeripheral] = [:]
    var peripheral: CBPeripheral?
    var rx: CBCharacteristic?
    var tx: CBCharacteristic?
    var reads: [CBCharacteristic] = []
    var pendingRead: CBCharacteristic?
    var pendingWrite = false
    var deferredWrite: Data?
    var writeType: CBCharacteristicWriteType {
        tx?.properties.contains(.write) == true ? .withResponse : .withoutResponse
    }
    var finishing = false

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }
    func fail(_ phase: String, _ error: Error?) {
        let e = error as NSError?
        emit("error", ["phase": phase, "domain": e?.domain ?? "probe", "code": e?.code ?? -1])
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
        central.scanForPeripherals(withServices: nil, options: nil)
        emit("scanning")
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            central.stopScan()
            guard self.candidates.count == 1, let p = self.candidates.values.first else {
                emit("selection", ["candidates": self.candidates.count])
                self.finish(); return
            }
            self.peripheral = p
            p.delegate = self
            emit("connecting")
            central.connect(p, options: nil)
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        guard name.lowercased().contains("band 10") else { return }
        if candidates[p.identifier] == nil { emit("candidate", ["model": "Mi Band 10", "rssi": RSSI]) }
        candidates[p.identifier] = p
    }
    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        emit("connected")
        emit("discovering_services")
        p.discoverServices([CBUUID(string: "FE95")])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { fail("connect", error) }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        let e = error as NSError?
        emit("disconnected", ["domain": e?.domain ?? "", "code": e?.code ?? 0])
        if !finishing { finish() }
    }
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let s = p.services?.first(where: { $0.uuid == CBUUID(string: "FE95") }) else { fail("services", error); return }
        emit("discovering_characteristics")
        p.discoverCharacteristics(nil, for: s)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil else { fail("characteristics", error); return }
        let chars = service.characteristics ?? []
        emit("characteristics", ["items": chars.map { ["uuid": $0.uuid.uuidString, "properties": $0.properties.rawValue] as [String: Any] }])
        rx = chars.first { $0.uuid == CBUUID(string: "005E") }
        tx = chars.first { $0.uuid == CBUUID(string: "005F") }
        guard rx != nil, tx != nil else { fail("BLE_V2_characteristics_missing", nil); return }
        // macOS may request pairing if one of these reads requires authentication.
        reads = chars.filter { $0.properties.contains(.read) }
        readNext()
    }
    func readNext() {
        guard let p = peripheral else { return }
        if !reads.isEmpty {
            let c = reads.removeFirst()
            pendingRead = c
            emit("reading", ["uuid": c.uuid.uuidString])
            p.readValue(for: c)
        } else if let rx = rx {
            emit("subscribing")
            p.setNotifyValue(true, for: rx)
        }
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        if pendingRead === c {
            pendingRead = nil
            let e = error as NSError?
            emit("read_result", ["uuid": c.uuid.uuidString, "ok": error == nil, "bytes": c.value?.count ?? 0, "domain": e?.domain ?? "", "code": e?.code ?? 0])
            readNext(); return
        }
        guard error == nil, let value = c.value else { fail("notification", error); return }
        if c === rx { emit("data", ["base64": value.base64EncodedString()]) }
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        guard error == nil, c.isNotifying else { fail("subscribe", error); return }
        emit("ready", ["maxWrite": p.maximumWriteValueLength(for: writeType), "bond": "unknown"])
    }
    func peripheral(_ p: CBPeripheral, didWriteValueFor c: CBCharacteristic, error: Error?) {
        pendingWrite = false
        guard error == nil else { fail("write", error); return }
        emit("written")
    }
    func peripheralIsReady(toSendWriteWithoutResponse p: CBPeripheral) {
        flushWriteWithoutResponse()
    }
    func flushWriteWithoutResponse() {
        guard let p = peripheral, let tx = tx, p.canSendWriteWithoutResponse,
              let bytes = deferredWrite, !finishing else { return }
        deferredWrite = nil
        p.writeValue(bytes, for: tx, type: .withoutResponse)
        pendingWrite = false
        // Queued by CoreBluetooth; this is not an ATT acknowledgement.
        emit("written")
    }
    func command(_ object: [String: Any]) {
        if object["op"] as? String == "close" { finish(); return }
        guard !finishing, object["op"] as? String == "write", !pendingWrite,
              let p = peripheral, let tx = tx,
              let s = object["base64"] as? String, let bytes = Data(base64Encoded: s),
              bytes.count <= p.maximumWriteValueLength(for: writeType),
              tx.properties.contains(.write) || tx.properties.contains(.writeWithoutResponse)
        else { fail("invalid_write", nil); return }
        pendingWrite = true
        if writeType == .withResponse {
            p.writeValue(bytes, for: tx, type: .withResponse)
        } else {
            deferredWrite = bytes
            flushWriteWithoutResponse()
        }
    }
}

let probe = Probe()
DispatchQueue.global().async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        DispatchQueue.main.async { probe.command(obj) }
    }
    DispatchQueue.main.async { probe.finish() }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { emit("timeout"); probe.finish() }
RunLoop.main.run()
