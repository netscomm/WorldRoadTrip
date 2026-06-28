// Reads an MP4/MOV container's capture time + duration without ffprobe, by
// walking top-level boxes (atoms) to find moov > mvhd. Box headers are tiny
// (8-16 bytes) and File.slice() doesn't read data until awaited, so this is
// cheap even on a 17GB file with a huge mdat before moov.
//
// Verified against scripts/build_data.py's ffprobe-based creation_time for a
// real DJI clip: mvhd.creation_time (QuickTime epoch) matched ffprobe's
// reported creation_time tag exactly for the sample checked.

const QUICKTIME_EPOCH_OFFSET_SECONDS = 2082844800; // 1904-01-01 -> 1970-01-01

async function readBoxHeader(file, offset) {
  const buf = await file.slice(offset, offset + 16).arrayBuffer();
  const view = new DataView(buf);
  let boxSize = view.getUint32(0);
  const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
  let headerLen = 8;
  if (boxSize === 1) {
    // 64-bit extended size follows the type.
    const hi = view.getUint32(8);
    const lo = view.getUint32(12);
    boxSize = hi * 2 ** 32 + lo;
    headerLen = 16;
  } else if (boxSize === 0) {
    boxSize = file.size - offset;
  }
  return { type, boxSize, headerLen, offset };
}

async function findChildBox(file, rangeStart, rangeEnd, targetType) {
  let offset = rangeStart;
  while (offset < rangeEnd) {
    const box = await readBoxHeader(file, offset);
    if (box.boxSize <= 0) break; // malformed, avoid an infinite loop
    if (box.type === targetType) return box;
    offset += box.boxSize;
  }
  return null;
}

async function getMp4CreationTime(file) {
  const moov = await findChildBox(file, 0, file.size, "moov");
  if (!moov) return null;

  const moovContentStart = moov.offset + moov.headerLen;
  const moovContentEnd = moov.offset + moov.boxSize;
  const mvhd = await findChildBox(file, moovContentStart, moovContentEnd, "mvhd");
  if (!mvhd) return null;

  const contentOffset = mvhd.offset + mvhd.headerLen;
  const buf = await file.slice(contentOffset, contentOffset + 20).arrayBuffer();
  const view = new DataView(buf);
  const version = view.getUint8(0);
  const creationTimeRaw = version === 1 ? Number(view.getBigUint64(4)) : view.getUint32(4);
  const unixSeconds = creationTimeRaw - QUICKTIME_EPOCH_OFFSET_SECONDS;
  return new Date(unixSeconds * 1000);
}

function getVideoDurationSeconds(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    video.src = url;
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not read video metadata"));
    };
  });
}
