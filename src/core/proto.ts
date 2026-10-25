import protobuf from 'protobufjs';

// Subset of Gadgetbridge's xiaomi.proto (GBProtobufGenerator/src/main/proto), field numbers unchanged.
// proto2 so that explicitly-set default values are still serialized, as the band expects.
const SCHEMA = `
syntax = "proto2";
package xiaomi;

message Command {
  required uint32 type = 1;
  optional uint32 subtype = 2;
  optional Account auth = 3;
  optional System system = 4;
  optional Watchface watchface = 6;
  optional Health health = 10;
  optional Rpk rpk = 22;
  optional DataUpload dataUpload = 24;
  optional uint32 status = 100;
}

// Field names in comments are Xiaomi's own, from the fuller schema in AstroBox-NG-Module-Pb
// (protos/xiaomi/wear_account.proto): Account is a oneof there.
message Account {
  optional bool bindStatus = 1;         // bind_status: the band's answer to subtype 0 (BIND_STATUS)
  // error_code (Account.ErrorCode): sent instead of a DeviceVerify when the band refuses step 1.
  // 4 = NO_BOUND, seen from a Mi Band 10 paired with Mi Fitness on an iPad. See ACCOUNT_ERRORS in auth.ts.
  optional uint32 errorCode = 3;
  optional string userId = 7;
  optional uint32 status = 8;
  optional AppVerify appVerify = 30;
  optional DeviceVerify deviceVerify = 31;
  optional AppConfirm appConfirm = 32;
  optional DeviceConfirm authStep4 = 33;
}

message AppVerify {
  required bytes nonce = 1;             // app_random
  optional string deviceId = 2;         // app_device_id
  optional bool checkDynamicCode = 3;   // check_dynamic_code
}
message DeviceVerify {
  required bytes nonce = 1;
  required bytes hmac = 2;
}
message AppConfirm {
  required bytes encryptedNonces = 1;
  required bytes encryptedDeviceInfo = 2;
}
message DeviceConfirm {
  required bool unknown1 = 1;
  optional uint32 device_capability = 2;
  optional uint32 device_capability_2 = 3;
}

message CompanionDevice {
  required uint32 unknown1 = 1;         // device_type: 0 ANDROID, 1 IOS, 2 VELA, 15 OTHER
  required float phoneApiLevel = 2;
  required string phoneName = 3;
  required uint32 unknown3 = 4;
  required string region = 5;
}

message System {
  optional Power power = 2;
  optional DeviceInfo deviceInfo = 3;
}
message Power {
  optional Battery battery = 1;
}
message Battery {
  optional uint32 level = 1;
  optional uint32 state = 2;
}
message DeviceInfo {
  optional string serialNumber = 1;
  optional string firmware = 2;
  optional string unknown3 = 3;
  optional string model = 4;
}

// wear_fitness.proto
message Health {
  optional bytes activityRequestFileIds = 2;
  optional bytes activitySyncAckFileIds = 3;
  optional ActivitySyncRequestToday activitySyncRequestToday = 5;
}
message ActivitySyncRequestToday {
  optional uint32 unknown1 = 1;
}

message Watchface {
  optional WatchfaceList watchfaceList = 1;
  optional string watchfaceId = 2;
  optional uint32 ack = 4;
  optional uint32 installStatus = 5;
  optional WatchfaceInstallStart watchfaceInstallStart = 6;
}
message WatchfaceList {
  repeated WatchfaceInfo watchface = 1;
}
message WatchfaceInfo {
  optional string id = 1;
  optional string name = 2;
  optional bool active = 3;
  optional bool canDelete = 4;
}
message WatchfaceInstallStart {
  optional string id = 1;
  optional uint32 size = 2;
}

message Rpk {
  optional RpkList rpkList = 1;
  optional RpkInfo rpkInfo = 2;
  optional RpkInstallStart rpkInstallStart = 3;
  optional RpkInfoList rpkDel = 5;
}
message RpkList {
  repeated RpkInfoList rpkInfo = 1;
}
message RpkInfo {
  optional string id = 1;
  optional uint32 unknown2 = 2;
  optional uint32 size = 3;
}
message RpkInfoList {
  optional string id = 1;
  optional bytes sha = 2;
  optional uint32 unknown3 = 3;
  optional uint32 unknown4 = 4;
  optional string name = 5;
}
message RpkInstallStart {
  optional uint32 cmd = 1;
}

message DataUpload {
  optional DataUploadRequest dataUploadRequest = 1;
  optional DataUploadAck dataUploadAck = 2;
}
message DataUploadRequest {
  optional uint32 type = 1;
  optional bytes md5sum = 2;
  optional uint32 size = 3;
}
message DataUploadAck {
  optional bytes md5sum = 1;
  optional uint32 errno = 2;
  optional uint32 resumePosition = 4;
  optional uint32 chunkSize = 5;
}
`;

const root = protobuf.parse(SCHEMA, { keepCase: true }).root;
const CommandType = root.lookupType('xiaomi.Command');
const CompanionDeviceType = root.lookupType('xiaomi.CompanionDevice');

export interface WatchfaceInfo { id?: string; name?: string; active?: boolean; canDelete?: boolean }
export interface RpkInfoList { id?: string; sha?: Uint8Array; name?: string }

export interface Command {
  type: number;
  subtype?: number;
  auth?: {
    bindStatus?: boolean;
    errorCode?: number;
    userId?: string;
    status?: number;
    appVerify?: { nonce: Uint8Array; deviceId?: string; checkDynamicCode?: boolean };
    deviceVerify?: { nonce: Uint8Array; hmac: Uint8Array };
    appConfirm?: { encryptedNonces: Uint8Array; encryptedDeviceInfo: Uint8Array };
    authStep4?: { unknown1?: boolean };
  };
  system?: {
    power?: { battery?: { level?: number; state?: number } };
    deviceInfo?: { serialNumber?: string; firmware?: string; model?: string };
  };
  watchface?: {
    watchfaceList?: { watchface?: WatchfaceInfo[] };
    watchfaceId?: string;
    installStatus?: number;
    watchfaceInstallStart?: { id?: string; size?: number };
  };
  health?: {
    activityRequestFileIds?: Uint8Array;
    activitySyncAckFileIds?: Uint8Array;
    activitySyncRequestToday?: { unknown1?: number };
  };
  rpk?: {
    rpkList?: { rpkInfo?: RpkInfoList[] };
    rpkInfo?: { id?: string; unknown2?: number; size?: number };
    rpkInstallStart?: { cmd?: number };
    rpkDel?: RpkInfoList;
  };
  dataUpload?: {
    dataUploadRequest?: { type?: number; md5sum?: Uint8Array; size?: number };
    dataUploadAck?: { md5sum?: Uint8Array; errno?: number; resumePosition?: number; chunkSize?: number };
  };
  status?: number;
}

export function encodeCommand(cmd: Command): Uint8Array {
  return CommandType.encode(CommandType.fromObject(cmd)).finish();
}

export function decodeCommand(bytes: Uint8Array): Command {
  const msg = CommandType.decode(bytes);
  return CommandType.toObject(msg, { longs: Number }) as Command;
}

export function encodeCompanionDevice(d: { unknown1: number; phoneApiLevel: number; phoneName: string; unknown3: number; region: string }): Uint8Array {
  return CompanionDeviceType.encode(CompanionDeviceType.fromObject(d)).finish();
}
