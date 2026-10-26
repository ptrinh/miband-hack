#import <Foundation/Foundation.h>
#import <IOBluetooth/IOBluetooth.h>

static void emit(NSString *event, NSDictionary *fields) {
    NSMutableDictionary *out = [NSMutableDictionary dictionaryWithDictionary:fields ?: @{}];
    out[@"event"] = event;
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:json];
    [[NSFileHandle fileHandleWithStandardOutput] writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
}

@interface SPPProbe : NSObject <IOBluetoothRFCOMMChannelDelegate>
@property(strong) IOBluetoothDevice *device;
@property(strong) IOBluetoothRFCOMMChannel *channel;
@property(strong) NSMutableData *pendingWrite;
@property BOOL connectedBefore;
@property BOOL finishing;
- (void)command:(NSDictionary *)command;
- (void)finish;
@end

@implementation SPPProbe
- (void)fail:(NSString *)phase status:(IOReturn)status {
    emit(@"error", @{@"phase":phase, @"code":@(status)});
    [self finish];
}
- (void)finish {
    if (self.finishing) return;
    self.finishing = YES;
    if (self.channel) [self.channel closeChannel];
    if (self.device && !self.connectedBefore) [self.device closeConnection];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        emit(@"final_state", @{@"paired":@([self.device isPaired]), @"connected":@([self.device isConnected])});
        exit(0);
    });
}
- (void)command:(NSDictionary *)command {
    if ([command[@"op"] isEqual:@"close"]) { [self finish]; return; }
    if (self.finishing) return;
    if ([command[@"op"] isEqual:@"connect"] && !self.device) {
        NSString *address = command[@"address"];
        if (![address isKindOfClass:[NSString class]]) {
            // No address: the one paired device named like a Xiaomi band.
            NSArray *bands = [[IOBluetoothDevice pairedDevices] filteredArrayUsingPredicate:
                [NSPredicate predicateWithFormat:@"name BEGINSWITH[c] 'Xiaomi Smart Band'"]];
            emit(@"paired_bands", @{@"count":@(bands.count)});
            if (bands.count != 1) { [self fail:@"target" status:kIOReturnNotFound]; return; }
            address = [bands.firstObject addressString];
        }
        self.device = [IOBluetoothDevice deviceWithAddressString:address];
        if (!self.device) { [self fail:@"target" status:kIOReturnNotFound]; return; }
        self.connectedBefore = [self.device isConnected];
        emit(@"initial_state", @{@"paired":@([self.device isPaired]), @"connected":@(self.connectedBefore)});
        // A Mi Band 10 may never answer SDP (Chrome: "SDP query timeout"); a known channel skips it, as AstroBox does.
        NSNumber *fixed = command[@"channel"];
        if ([fixed isKindOfClass:[NSNumber class]] && fixed.intValue > 0) {
            emit(@"opening_rfcomm", @{@"channel":fixed, @"sdp":@NO});
            IOBluetoothRFCOMMChannel *channel = nil;
            IOReturn result = [self.device openRFCOMMChannelAsync:&channel withChannelID:(BluetoothRFCOMMChannelID)fixed.intValue delegate:self];
            self.channel = channel;
            if (result != kIOReturnSuccess) [self fail:@"start_rfcomm" status:result];
            return;
        }
        emit(@"discovering_sdp", nil);
        IOReturn result = [self.device performSDPQuery:self];
        if (result != kIOReturnSuccess) [self fail:@"start_sdp" status:result];
        return;
    }
    if ([command[@"op"] isEqual:@"write"] && self.channel && [self.channel isOpen] && !self.pendingWrite) {
        NSData *data = [[NSData alloc] initWithBase64EncodedString:command[@"base64"] options:0];
        if (!data || data.length > [self.channel getMTU] || data.length > UINT16_MAX) {
            [self fail:@"write_length" status:kIOReturnBadArgument]; return;
        }
        self.pendingWrite = [data mutableCopy];
        IOReturn result = [self.channel writeAsync:self.pendingWrite.mutableBytes length:(UInt16)self.pendingWrite.length refcon:NULL];
        if (result != kIOReturnSuccess) { self.pendingWrite = nil; [self fail:@"write" status:result]; }
        return;
    }
    [self fail:@"invalid_command" status:kIOReturnBadArgument];
}
- (void)sdpQueryComplete:(IOBluetoothDevice *)device status:(IOReturn)status {
    if (self.finishing) return;
    if (status != kIOReturnSuccess) { [self fail:@"sdp" status:status]; return; }
    IOBluetoothSDPServiceRecord *record = [device getServiceRecordForUUID:[IOBluetoothSDPUUID uuid16:0x1101]];
    emit(@"sdp_result", @{@"serviceCount":@(device.services.count), @"sppPresent":@(record != nil)});
    if (!record) { [self finish]; return; }
    BluetoothRFCOMMChannelID channelID = 0;
    IOReturn result = [record getRFCOMMChannelID:&channelID];
    if (result != kIOReturnSuccess) { [self fail:@"spp_channel" status:result]; return; }
    emit(@"opening_rfcomm", @{@"channel":@(channelID)});
    IOBluetoothRFCOMMChannel *channel = nil;
    result = [device openRFCOMMChannelAsync:&channel withChannelID:channelID delegate:self];
    self.channel = channel;
    if (result != kIOReturnSuccess) [self fail:@"start_rfcomm" status:result];
}
- (void)rfcommChannelOpenComplete:(IOBluetoothRFCOMMChannel *)channel status:(IOReturn)status {
    if (self.finishing) return;
    if (status != kIOReturnSuccess) { [self fail:@"rfcomm" status:status]; return; }
    self.channel = channel;
    emit(@"ready", @{@"maxWrite":@([channel getMTU]), @"paired":@([self.device isPaired])});
}
- (void)rfcommChannelData:(IOBluetoothRFCOMMChannel *)channel data:(void *)bytes length:(size_t)length {
    if (self.finishing) return;
    NSData *data = [NSData dataWithBytes:bytes length:length];
    emit(@"data", @{@"base64":[data base64EncodedStringWithOptions:0]});
}
- (void)rfcommChannelWriteComplete:(IOBluetoothRFCOMMChannel *)channel refcon:(void *)refcon status:(IOReturn)status {
    self.pendingWrite = nil;
    if (self.finishing) return;
    if (status != kIOReturnSuccess) { [self fail:@"write_complete" status:status]; return; }
    emit(@"written", nil);
}
- (void)rfcommChannelClosed:(IOBluetoothRFCOMMChannel *)channel {
    if (self.finishing) return;
    emit(@"disconnected", nil);
    [self finish];
}
@end

int main(void) {
    @autoreleasepool {
        SPPProbe *probe = [SPPProbe new];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char *line = NULL; size_t capacity = 0;
            while (getline(&line, &capacity, stdin) != -1) {
                NSData *data = [[NSString stringWithUTF8String:line] dataUsingEncoding:NSUTF8StringEncoding];
                id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                if ([object isKindOfClass:[NSDictionary class]]) dispatch_async(dispatch_get_main_queue(), ^{ [probe command:object]; });
            }
            free(line);
            dispatch_async(dispatch_get_main_queue(), ^{ [probe finish]; });
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 90 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if ([probe.channel isOpen]) return; // a live bridge session stays up until closed
            emit(@"timeout", nil); [probe finish];
        });
        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
