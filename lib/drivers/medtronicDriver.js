/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2016, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */

/* global chrome */

var _ = require('lodash');
var async = require('async');
var sundial = require('sundial');
var struct = require('../struct.js')();
var annotate = require('../eventAnnotations');
var TZOUtil = require('../TimezoneOffsetUtil');
var proc = require('../medtronic/processData');
var common = require('../commonFunctions');
var medtronicSimulator = require('../medtronic/medtronicSimulator');
var crcCalculator = require('../crc.js');

var isBrowser = typeof window !== 'undefined';
var debug = isBrowser ? require('../bows')('MedtronicDriver') : console.log;

module.exports = function (config) {
  var cfg = _.clone(config);
  var hidDevice = config.deviceComms;
  var HID_PACKET_SIZE = 64;
  var RETRIES = 6;
  var MAGIC_HEADER = 'ABC';
  var simulator = null;

  // Metronic's Bayer Contour Next Link implementation uses polynomial 0x9b for its CRC
  crcCalculator.crc8_init(0x9b);

  var ASCII_CONTROL = {
    ACK : 0x06,
    CR : 0x0D,
    ENQ : 0x05,
    EOT : 0x04,
    ETB : 0x17,
    ETX : 0x03,
    LF : 0x0A,
    NAK : 0x15,
    STX : 0x02
  };

  var COMMANDS = {
    // Bayer Contour Next commands to place meter
    // into remote command mode
    GET_WRITE : [0x57,0x7c], // W|
    GET_QUERY : [0x51,0x7c], // Q|
    GET_MAGIC : [0x31,0x7c], // 1|
    GET_END : [0x30,0x7c],   // 0|

    // Medtronic commands
    OPEN_CONNECTION : [0x10,0x01,0x1E],
    SEND_MESSAGE : [0x12,0x21,0x05]
  };

  var MESSAGES = {
    READ_HISTORY : 0x80
  };

  var serial;
  var medtronicHeader;

  var messageBuffer = {
    reset: function(){
      this.bytes = new Uint8Array(0);
      this.valid = false;
      this.messageLength = 0;
      this.payload = null;
      return this;
    },
    setValid: function(){
      this.payload = String.fromCharCode.apply(null, this.bytes);
      this.valid = true;
    },
    clone: function(){
      return _.clone(this);
    }
  }.reset();

  var probe = function(cb){
    debug('not probing Medtronic');
  };

  var _sum_lsb = function(bytes) {
    // checksum algorithm sums all bytes and uses lsb
    var sum = 0;
    bytes.forEach(function (byte) {
      sum += byte;
    });
    return sum & 0xff;
  };

  var buildMedtronicPacket = function (type, command, parameter) {
    // first construct payload before we can determine packet length
    var payload = [];
    if(command != null) {

      if(parameter != null) {
        payload = medtronicHeader.concat(command,parameter);
        var padding = _.fill(new Array(20),0);
        payload = payload.concat(padding);
      } else {
        payload = medtronicHeader.concat(command,0x00);
        var payloadChecksum = crcCalculator.crc8_checksum(payload);
        payload = payload.concat(payloadChecksum);
      }
    }

    var datalen = 30 + type.length + payload.length;
    var buf = new ArrayBuffer(datalen + 4); // include 4-byte header
    var bytes = new Uint8Array(buf);

    var ctr = struct.pack(bytes, 0, '6b6z10b', 0x00, 0x00, 0x00, datalen, 0x51, 0x01, serial,
                                                0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    ctr += struct.copyBytes(bytes, ctr, type, type.length);

    var secondPacketLength = 44;
    if(parameter != null ) {
      ctr += struct.pack(bytes, ctr, '7bi', 0, 0, 0, 0x04, 0x10, 0x10, 0x00, payload.length+secondPacketLength);
    } else {
      ctr += struct.pack(bytes, ctr, '7bi', 0, 0, 0, 0, 0, 0, 0, payload.length);
    }

    var checkbytes = new Uint8Array(buf.slice(4)); // checksum excludes 4-byte header
    var ctr2 = struct.copyBytes(checkbytes, ctr - 4, payload, payload.length);

    if(parameter != null) {
      var secondPacket = buildPaddingPacket(command,parameter).checksum;
      struct.pack(checkbytes, ctr2 + payload.length + 4, 'b', secondPacket);
    }
    var checksum = _sum_lsb(checkbytes);

    ctr += struct.pack(bytes, ctr, 'b', checksum);
    ctr += struct.copyBytes(bytes, ctr, payload, payload.length);

    console.log('Sending bytes:', common.bytes2hex(bytes));
    return buf;
  };


  var buildPaddingPacket = function (command, parameter) {
    var length = 43;
    var padding = _.fill(new Array(length), 0);

    var prevPacketPadding = _.fill(new Array(20), 0);
    var checkbuf = medtronicHeader.concat(command,parameter,prevPacketPadding,padding);
    var checksum = crcCalculator.crc8_checksum(checkbuf);

    var datalen = length + 1; // include checksum
    var buf = new ArrayBuffer(datalen + 4 ); // include 4-byte header
    var bytes = new Uint8Array(buf);

    var ctr = struct.pack(bytes, 0, '4b', 0x00, 0x00, 0x00, datalen);
    ctr += struct.copyBytes(bytes, ctr, padding, padding.length);
    ctr += struct.pack(bytes, ctr, 'b', checksum);

    console.log('Padding packet:', common.bytes2hex(bytes));

    return {command : buf, checksum: checksum};
  };

  var readModel = function () {

    var cmd = 0x8D;

    return {
      command: buildMedtronicPacket(COMMANDS.SEND_MESSAGE,cmd),
      parser: function (packet) {
        var medtronicMessage = packet.slice(33);
        var messageLength = medtronicMessage[0];
        var model = struct.extractString(medtronicMessage,1,messageLength);
        return {model: model};
      }
    };
  };

  var sendCommand = function (cmd) {

    return {
      command: buildMedtronicPacket(COMMANDS.SEND_MESSAGE,cmd),
      parser: function (packet) {
        return true;
      }
    };
  };

  var readPage = function (cmd, page) {
    return {
      command1: buildMedtronicPacket(COMMANDS.SEND_MESSAGE,cmd,page),
      command2: buildPaddingPacket(cmd,page),
      parser: function (packet) {
        var medtronicMessage = packet.slice(33);
        return {message: medtronicMessage};
       }
    };
  };

  var extractPacketIntoMessage = function (bytes) {
    var packet_len = struct.extractByte(bytes, 0);

    // copying to a buffer in case there are multiple packets for one message
    // also discards the length byte from the beginning
    var tmpbuff = new Uint8Array(messageBuffer.messageLength + packet_len);
    struct.copyBytes(tmpbuff, 0, messageBuffer.bytes, messageBuffer.messageLength, 0);
    struct.copyBytes(tmpbuff, messageBuffer.messageLength, bytes, packet_len, 1);
    messageBuffer.bytes = tmpbuff;
    messageBuffer.messageLength += packet_len;

    messageBuffer.setValid();

    return messageBuffer;
  };

  var buildPacket = function (command, cmdlength) {
    var datalen = cmdlength + 4;
    var buf = new ArrayBuffer(datalen);
    var bytes = new Uint8Array(buf);

    var ctr = struct.pack(bytes, 0, 'bbbb', 0x00, 0x00, 0x00, cmdlength);
    ctr += struct.copyBytes(bytes, ctr, command, cmdlength);
    console.log('Sending bytes:', common.bytes2hex(bytes));
    return {
      command: buf,
      parser: function (packet) {
        //TODO: do we need to parse the first header packet for Bayer details?
        return null;
      }
    };
  };

  var buildAckPacket = function() {
    return buildPacket(ASCII_CONTROL.ACK, 1);
  };

  var buildNakPacket = function() {
    return buildPacket(ASCII_CONTROL.NAK, 1);
  };

  function decodeMessage (parser, message) {
    var response = struct.unpack(message, 0, 'b', ['recordType']);
    _.assign(response, parser(message));
    return response;
  }

  var getOneRecord = function (cmd, waitForENQ, callback) {
    var retry = 0;
    var robj = {};
    var error = false;

    // TODO: use async.retry and send NAK
    bcnCommandResponse(cmd, waitForENQ, function (err, record) {
      if (err) {
          return callback(err, null);
      } else {
        console.log('Record:', record);
        return callback(null,record);
      }
    });
  };

  var getRecords = function(packet, howMany, cb) {

    hidDevice.send(packet.command1, function () {
      hidDevice.send(packet.command2.command, function () {

        var page  = new Uint8Array(256 * howMany);
        var count = 0;
        async.whilst(
            function () { return count < howMany; },
            function (callback) {
                getMessage(20000, false, true, function(err, result) {
                  if (err) {
                    return callback(err, null);
                  }
                  var decoded = decodeMessage(packet.parser, result.bytes);
                  console.log('Part', count, 'of page:', decoded);
                  messageBuffer.reset();
                  page.set(decoded.message, 256 * count);
                  count++;
                  callback(null, count);
                });
            },
            function (err, count) {
              if(err) {
                return cb(err,null);
              }
              console.log('Read', count, 'parts per page.');
              return cb(null, page);
            }
        );
      });
    });
  };

  var bcnCommandResponse = function (commandpacket, waitForENQ, callback) {
    hidDevice.send(commandpacket.command, function () {
      getMessage(20000, waitForENQ, false, function(err, result) {
        if (err) {
          return callback(err, null);
        }
        var decoded = decodeMessage(commandpacket.parser, result.bytes);
        messageBuffer.reset();
        callback(null, decoded);
      });
    });
  };

  var getMessage = function (timeout, waitForENQ, inRemoteCommandMode, cb) {
    var done = false;

    var abortTimer = setTimeout(function () {
      debug('TIMEOUT');
      var e = new Error('Timeout error.');
      done = true;
      e.name = 'TIMEOUT';
      return cb(e, null);
    }, timeout);

    var message;

    async.doWhilst(
      function (callback) {
        hidDevice.receive(function(raw) {
          var packet = new Uint8Array(raw);
          // Only process if we get data
          if ( packet.length === 0 ) {
            return callback(false);
          }

          console.log('Raw packet received:', common.bytes2hex(packet));

          message = extractPacketIntoMessage(packet.slice(MAGIC_HEADER.length));

          var header = packet.slice(4,12);
          if(struct.extractByte(header,0) == 0x51 && _.isEqual(struct.extractString(header,2,6), serial)) {
            var payloadLength = struct.extractInt(packet,32);
            console.log('Payload length:', payloadLength);
          }

          if (message.messageLength > 33) {
            if (message.bytes.slice(33)[0] === ASCII_CONTROL.ACK ) {
              clearTimeout(abortTimer);
              return callback(true);
            }
          }

          var packetHead = struct.unpack(packet, 0, '3Z2b', ['HEADER', 'SIZE', 'BYTE1']);

          if(packetHead['HEADER'] !== MAGIC_HEADER){
            debug('Invalid packet from Bayer Contour Next Link');
            clearTimeout(abortTimer);
            cb(new Error('Invalid USB packet received.'));
            return callback(true);
          }

          // The tail of the packet starts 6 from the end, but because we haven't stripped the
          // MAGIC_HEADER and length byte from packet, we're using SIZE - 2
          var packetTail = struct.unpack(packet, parseInt(packetHead['SIZE']) - 2, '2b2Z2Z', ['CR', 'FRAME_TYPE', 'CHECKSUM', 'CRLF']);
          console.log('First byte:',common.bytes2hex([packetHead['BYTE1']]));
          console.log('Packet size:',packetHead['SIZE']);
          // HID_PACKET_SIZE - 4, because we don't include the MAGIC_HEADER or the SIZE
          if(waitForENQ) {
            if (packetHead['BYTE1'] == ASCII_CONTROL.ENQ) {
              clearTimeout(abortTimer);
              return callback(true);
            }
          } else if (inRemoteCommandMode) {
            if( packetHead['SIZE'] < ( HID_PACKET_SIZE - 4 )) {
              clearTimeout(abortTimer);
              return callback(true);
            }
          } else if( packetHead['SIZE'] < ( HID_PACKET_SIZE - 4 ) ||
              packetHead['BYTE1'] == ASCII_CONTROL.ENQ ||
              packetHead['BYTE1'] == ASCII_CONTROL.EOT ||
              packetHead['BYTE1'] == ASCII_CONTROL.ACK ||
              packetTail['FRAME_TYPE'] == ASCII_CONTROL.ETX ||
              packetTail['FRAME_TYPE'] == ASCII_CONTROL.ETB ) {
              clearTimeout(abortTimer);
              return callback(true);
          }
          return callback(false);
        });
      },
      function (valid) {
        return (valid !== true && done !== true);
      },
      function () {
          return cb(null, message);
      }
    );
  };

  var openConnection = function () {
    return {
      command: buildMedtronicPacket(COMMANDS.OPEN_CONNECTION),
      parser: function (packet) {
        return null;
      }
    };
  };

  return {
    detect: function(deviceInfo, cb){
      debug('no detect function needed', arguments);
      cb(null, deviceInfo);
    },

    setup: function (deviceInfo, progress, cb) {
      debug('in setup!');

      //TODO: remove this when we get serial number through UI
      // In the meanwhile, set with chrome.storage.local.set({'serial': <value>})
      if(isBrowser) {
        chrome.storage.local.get('serial', function(result) {
          if(result.serial) {
            console.log('Using', result.serial, 'as serial number.');
            serial = result.serial.toString();
          } else {
            console.log('using default serial number');
            chrome.storage.local.set({'serial': '698426'});
            serial = '698426';
          }

          medtronicHeader = [0xA7,parseInt(serial.substring(0,2),16),
                                     parseInt(serial.substring(2,4),16),
                                     parseInt(serial.substring(4,6),16)];

          progress(100);
          cb(null, {deviceInfo: deviceInfo});
        });
      } else {
        // pages are coming from CLI
        serial = '000000';
        progress(100);
        return cb(null, {deviceInfo: deviceInfo, pages:cfg.fileData});
      }
    },

    connect: function (progress, data, cb) {
      if(!isBrowser) {
        data.disconnect = false;
        return cb(null, data);
      }
      debug('in connect!');

      cfg.deviceComms.connect(data.deviceInfo, probe, function(err) {
        if (err) {
          return cb(err);
        }
        data.disconnect = false;
        progress(100);
        cb(null, data);
      });
    },

    getConfigInfo: function (progress, data, cb) {
      if(!isBrowser) {
        data.connect = true;
        data.settings = {modelNumber: '523'}; //TODO: get from device
        return cb(null, data);
      }
      debug('in getConfigInfo', data);

      var ACK_ERROR = 'Expected ACK during connect:';

      async.series({
        x : function(callback){
            getOneRecord(buildPacket([0x58],1), true, function (err, result) {
              if(err) {
                return cb(err,null);
              }
              callback(null, 'x');
            });
        },
        nak : function(callback){
            getOneRecord(buildPacket([ASCII_CONTROL.NAK], 1), false, function(err, result) {
              if(err) {
                return cb(err,null);
              }
              if(result.recordType !== ASCII_CONTROL.EOT) {
                return cb(new Error('Expected EOT.'), null);
              }
              callback(null, 'nak');
            });
        },
        enq : function(callback){
          getOneRecord(buildPacket([ASCII_CONTROL.ENQ], 1), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            if(result.recordType !== ASCII_CONTROL.ACK) {
              return cb(new Error(ACK_ERROR + 'ENQ'), null);
            }
            callback(null, 'enq');
          });
        },
        write : function(callback){
          getOneRecord(buildPacket(COMMANDS.GET_WRITE, 2), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            if(result.recordType !== ASCII_CONTROL.ACK) {
              return cb(new Error(ACK_ERROR + 'WRITE'), null);
            }
            callback(null, 'write');
          });
        },
        query : function(callback){
          getOneRecord(buildPacket(COMMANDS.GET_QUERY, 2), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            if(result.recordType !== ASCII_CONTROL.ACK) {
              return cb(new Error(ACK_ERROR + 'QUERY'), null);
            }
            callback(null, 'query');
          });
        },
        magic : function(callback){
          getOneRecord(buildPacket(COMMANDS.GET_MAGIC, 2), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            if(result.recordType !== ASCII_CONTROL.ACK) {
              return cb(new Error(ACK_ERROR + 'MAGIC'), null);
            }
            callback(null, 'magic');
          });
        },
        open_connection : function(callback){
          getOneRecord(openConnection(), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            callback(null, 'open');
          });
        },
        model : function(callback){
          getOneRecord(readModel(), false, function(err, result) {
            if(err) {
              return cb(err,null);
            }
            callback(null, {settings: {modelNumber: result.model}});
          });
        }
      },
      function(err, results){
          progress(100);

          if(!err){
              data.connect = true;
              _.assign(data, results.model);
              return cb(null, data);
          } else {
              return cb(err,results);
          }
      });
    },

    fetchData: function (progress, data, cb) {
      if(!isBrowser) {
        data.fetchData = true;
        return cb(null, data);
      }
      debug('in fetchData', data);

      progress(0);
      async.series({
        readHistory : function(callback){
          var count = 0;
          var pages = [];

          async.whilst(
              function () { return count < 9; },
              function (callback) {
                  getOneRecord(sendCommand(MESSAGES.READ_HISTORY), true, function (err, result) {
                    if(err) {
                      return callback(err,null);
                    }
                    if(result) {
                      getRecords(readPage(MESSAGES.READ_HISTORY,[0x01,count]), 4, function (err, result) {
                        if(err) {
                          return callback(err,null);
                        }
                        if(result) {
                          pages[count] = result;
                          count++;
                          return callback(null, count);
                        } else {
                          return cb(new Error('No history'));
                        }
                      });
                    } else {
                      return cb(new Error('No history'));
                    }
                  });
              },
              function (err, n) {
                  if(err) {
                    return cb(err,null);
                  } else {
                    console.log('Read', n, 'pages');
                    _.assign(data, { pages : pages });
                    return cb(null, data);
                  }
              }
          );
        },
      },
      function(err, results){
          if(!err){
            progress(100);
            data.fetchData = true;
            cb(null, data);
          } else {
            return cb(err,results);
          }
      });
    },

    processData: function (progress, data, cb) {
      debug('in processData');
      data.settings.deviceId = data.settings.modelNumber + '-' + serial;
      cfg.builder.setDefaults({ deviceId: data.settings.deviceId});
      // TODO: get all time changes and most recent event
      cfg.tzoUtil = new TZOUtil(cfg.timezone, new Date().toISOString(), []);
      progress(0);
      proc.init(cfg);
      proc.processPages(data, function (err, records) {
        var postrecords = proc.buildBolusRecords(records);
        postrecords = postrecords.concat(proc.buildWizardRecords(records));
        postrecords = postrecords.concat(proc.buildBGRecords(records));

        simulator = medtronicSimulator.make({settings: data.settings});

        // sort by log index
        postrecords = _.sortBy(postrecords, function(d) { return d.index; });
        // sort by time
        postrecords = _.sortBy(postrecords, function(d) { return d.time; });

        for (var j = 0; j < postrecords.length; ++j) {
          var datum = postrecords[j];
          switch (datum.type) {
            case 'bolus':
              simulator.bolus(datum);
              break;
            case 'wizard':
              simulator.wizard(datum);
              break;
            case 'smbg':
              simulator.smbg(datum);
              break;
            default:
              debug('[Hand-off to simulator] Unhandled type!', datum.type);
          }
        }

        progress(100);
        data.processData = true;

        data.post_records = simulator.getEvents();
        delete data.pages;
        console.log('Data:', JSON.stringify(data, null, '\t'));
        cb(null, data);
      });
    },

    uploadData: function (progress, data, cb) {
      progress(0);

      var sessionInfo = {
        deviceTags: ['insulin-pump'],
        deviceManufacturers: ['Medtronic'],
        deviceModel: data.settings.modelNumber,
        deviceSerialNumber: serial,
        deviceId: data.settings.deviceId,
        start: sundial.utcDateString(),
        timeProcessing: cfg.tzoUtil.type,
        tzName : cfg.timezone,
        version: cfg.version
      };

      cfg.api.upload.toPlatform(data.post_records, sessionInfo, progress, cfg.groupId, function (err, result) {
        progress(100);

        if (err) {
          debug(err);
          debug(result);
          return cb(err, data);
        } else {
          data.cleanup = true;
          return cb(null, data);
        }
      });

    },

    disconnect: function (progress, data, cb) {
      debug('in disconnect');
      progress(100);
      cb(null,data);
    },

    cleanup: function (progress, data, cb) {
      debug('in cleanup');

      if(isBrowser) {
        // always make sure that we're exiting remote command mode on the
        // Bayer Contour Next Link, so that we can enter it again next time
        getOneRecord(buildPacket(COMMANDS.GET_WRITE, 2), false, function(err, result) {
          getOneRecord(buildPacket(COMMANDS.GET_QUERY, 2), false, function(err, result) {
            getOneRecord(buildPacket(COMMANDS.GET_END, 2), false, function(err, result) {
              getOneRecord(buildPacket([ASCII_CONTROL.EOT],1), false, function(err, result) {
                if(!data.disconnect){
                    cfg.deviceComms.disconnect(data, function() {
                        progress(100);
                        data.cleanup = true;
                        data.disconnect = true;
                        cb(null, data);
                    });
                } else {
                  progress(100);
                  cb(null,data);
                }
              });
            });
          });
        });
      } else {
        progress(100);
        cb(null,data);
      }

    }
  };
};