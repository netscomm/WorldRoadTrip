// Minimal FIT binary parser, scoped to exactly what the map needs from a
// ride file: GPS position + altitude + timestamp from "record" messages
// (global message number 20). Not a general-purpose FIT SDK - developer
// fields and most message types are skipped (their bytes are consumed using
// the field sizes from their Definition Message, but never interpreted).
// Mirrors parse_fit_file() in scripts/build_data.py.

const FIT_RECORD_MESG_NUM = 20;
const FIT_FIELD_TIMESTAMP = 253;
const FIT_FIELD_POSITION_LAT = 0;
const FIT_FIELD_POSITION_LONG = 1;
const FIT_FIELD_ALTITUDE = 2;
const FIT_FIELD_ENHANCED_ALTITUDE = 78;

// Seconds between the Unix epoch (1970-01-01) and the FIT epoch (1989-12-31).
const FIT_EPOCH_OFFSET_SECONDS = 631065600;

// Same fixed local-time offset build_data.py uses for this (Italy, CEST)
// trip. Will need to become per-trip/timezone-aware once rides outside
// CEST are added.
const FIT_TO_LOCAL_OFFSET_MS = 2 * 60 * 60 * 1000;

const SEMI_TO_DEG = 180.0 / Math.pow(2, 31);

// base_type byte -> byte width. Only the types we might actually need to
// read (lat/long/timestamp/altitude) are interpreted beyond their width;
// everything else is only ever skipped using this width.
const BASE_TYPE_SIZE = {
  0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 1,
  9: 4, 10: 1, 11: 2, 12: 4, 13: 1, 14: 8, 15: 8, 16: 8, 17: 1,
};

function readByType(view, offset, baseType, littleEndian) {
  const t = baseType & 0x1f;
  switch (t) {
    case 0: return view.getUint8(offset); // enum
    case 1: return view.getInt8(offset); // sint8
    case 2: return view.getUint8(offset); // uint8
    case 3: return view.getInt16(offset, littleEndian); // sint16
    case 4: return view.getUint16(offset, littleEndian); // uint16
    case 5: return view.getInt32(offset, littleEndian); // sint32
    case 6: return view.getUint32(offset, littleEndian); // uint32
    case 7: return null; // string - not needed
    case 8: return view.getFloat32(offset, littleEndian); // float32
    case 9: return view.getFloat64(offset, littleEndian); // float64
    case 10: return view.getUint8(offset); // uint8z
    case 11: return view.getUint16(offset, littleEndian); // uint16z
    case 12: return view.getUint32(offset, littleEndian); // uint32z
    default: return null;
  }
}

function parseFit(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const headerSize = view.getUint8(0);
  const dataSize = view.getUint32(4, true);
  const sig = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (sig !== ".FIT") {
    throw new Error("not a FIT file (missing .FIT signature)");
  }

  const end = headerSize + dataSize;
  let offset = headerSize;
  const definitions = {}; // localMessageType -> { globalMesgNum, littleEndian, fields: [{num, size, baseType}] }
  const points = [];
  let lastTimestamp = null;

  while (offset < end) {
    const header = view.getUint8(offset);
    offset += 1;

    if (header & 0x80) {
      // Compressed Timestamp Header data message.
      const localType = (header >> 5) & 0x3;
      const timeOffset = header & 0x1f;
      const def = definitions[localType];
      if (!def) break; // malformed stream, bail out gracefully
      if (lastTimestamp !== null) {
        let ts = (lastTimestamp & ~0x1f) | timeOffset;
        if (ts < lastTimestamp) ts += 0x20;
        lastTimestamp = ts;
      }
      offset = consumeDataMessage(view, offset, def, lastTimestamp, points);
      continue;
    }

    const isDefinition = (header & 0x40) !== 0;
    const localType = header & 0xf;

    if (isDefinition) {
      offset += 1; // reserved
      const architecture = view.getUint8(offset);
      offset += 1;
      const littleEndian = architecture === 0;
      const globalMesgNum = view.getUint16(offset, littleEndian);
      offset += 2;
      const numFields = view.getUint8(offset);
      offset += 1;
      const fields = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({
          num: view.getUint8(offset),
          size: view.getUint8(offset + 1),
          baseType: view.getUint8(offset + 2),
        });
        offset += 3;
      }
      let devFields = [];
      if (header & 0x20) {
        // has developer fields - just skip their bytes, never interpreted
        const numDev = view.getUint8(offset);
        offset += 1;
        for (let i = 0; i < numDev; i++) {
          devFields.push({ size: view.getUint8(offset + 1) });
          offset += 3;
        }
      }
      definitions[localType] = { globalMesgNum, littleEndian, fields, devFields };
    } else {
      const def = definitions[localType];
      if (!def) break;
      const result = consumeDataMessage(view, offset, def, null, points);
      offset = result;
    }
  }

  points.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return points;
}

function consumeDataMessage(view, offset, def, compressedTimestamp, points) {
  const isRecord = def.globalMesgNum === FIT_RECORD_MESG_NUM;
  let lat = null;
  let lon = null;
  let alt = null;
  let timestamp = compressedTimestamp;

  for (const field of def.fields) {
    if (isRecord) {
      if (field.num === FIT_FIELD_TIMESTAMP && field.size === 4) {
        // uint32 invalid sentinel per FIT spec is 0xFFFFFFFF.
        const raw = readByType(view, offset, 0x06, def.littleEndian);
        if (raw !== 0xffffffff) timestamp = raw;
      } else if (field.num === FIT_FIELD_POSITION_LAT && field.size === 4) {
        // sint32 invalid sentinel is 0x7FFFFFFF (no GPS fix yet).
        const raw = readByType(view, offset, 0x05, def.littleEndian);
        if (raw !== 0x7fffffff) lat = raw;
      } else if (field.num === FIT_FIELD_POSITION_LONG && field.size === 4) {
        const raw = readByType(view, offset, 0x05, def.littleEndian);
        if (raw !== 0x7fffffff) lon = raw;
      } else if (field.num === FIT_FIELD_ALTITUDE && field.size === 2) {
        // uint16 invalid sentinel is 0xFFFF.
        const raw = readByType(view, offset, 0x04, def.littleEndian);
        if (raw !== 0xffff) alt = raw / 5 - 500;
      } else if (field.num === FIT_FIELD_ENHANCED_ALTITUDE && field.size === 4) {
        const raw = readByType(view, offset, 0x06, def.littleEndian);
        if (raw !== 0xffffffff) alt = raw / 5 - 500;
      }
    }
    offset += field.size;
  }
  for (const dev of def.devFields) {
    offset += dev.size;
  }

  if (isRecord && lat !== null && lon !== null && timestamp !== null) {
    const ms = (timestamp + FIT_EPOCH_OFFSET_SECONDS) * 1000 + FIT_TO_LOCAL_OFFSET_MS;
    points.push({
      t: new Date(ms).toISOString().replace(".000Z", "").replace("Z", ""),
      lat: lat * SEMI_TO_DEG,
      lon: lon * SEMI_TO_DEG,
      alt,
    });
  }

  return offset;
}
