/** Annex-B H.264 parsing shared by the WebCodecs and MSE paths. */

export function splitNALs(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const starts = [];
  for (let i = 0; i + 2 < bytes.length; ) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      starts.push({ index: i, length: 3 });
      i += 3;
    } else if (i + 3 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      starts.push({ index: i, length: 4 });
      i += 4;
    } else {
      i += 1;
    }
  }
  const nals = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1].index : bytes.length;
    const nalStart = start.index + start.length;
    if (nalStart >= end) continue;
    nals.push({
      start: start.index,
      nalStart,
      end,
      type: bytes[nalStart] & 0x1f,
      bytes: bytes.subarray(nalStart, end),
    });
  }
  return nals;
}

export function inspectAccessUnit(data) {
  let hasIDR = false;
  let sps = null;
  let pps = null;
  for (const nal of splitNALs(data)) {
    if (nal.type === 5) hasIDR = true;
    if (nal.type === 7) sps = nal.bytes;
    if (nal.type === 8) pps = nal.bytes;
  }
  return { hasIDR, sps, pps };
}

/** Converts Annex-B start codes to the 4-byte lengths avcC expects. */
export function annexBToAVCC(data) {
  const nals = splitNALs(data);
  let size = 0;
  for (const nal of nals) size += 4 + nal.bytes.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    const length = nal.bytes.length;
    out[offset] = (length >>> 24) & 0xff;
    out[offset + 1] = (length >>> 16) & 0xff;
    out[offset + 2] = (length >>> 8) & 0xff;
    out[offset + 3] = length & 0xff;
    out.set(nal.bytes, offset + 4);
    offset += 4 + length;
  }
  return out;
}

export function buildAVCDecoderConfig(sps, pps) {
  const spsBytes = sps instanceof Uint8Array ? sps : new Uint8Array(sps);
  const ppsBytes = pps instanceof Uint8Array ? pps : new Uint8Array(pps);
  // avcC: version, profile, compatibility, level, 0xfc | lengthSizeMinusOne,
  // 0xe0 | numSPS, SPS length, SPS, numPPS, PPS length, PPS.
  const config = new Uint8Array(11 + spsBytes.length + ppsBytes.length);
  config[0] = 1;
  config[1] = spsBytes[1] ?? 0x42;
  config[2] = spsBytes[2] ?? 0xe0;
  config[3] = spsBytes[3] ?? 0x1f;
  config[4] = 0xff; // 4-byte NAL lengths
  config[5] = 0xe1; // one SPS
  config[6] = (spsBytes.length >>> 8) & 0xff;
  config[7] = spsBytes.length & 0xff;
  config.set(spsBytes, 8);
  let offset = 8 + spsBytes.length;
  config[offset] = 1; // one PPS
  config[offset + 1] = (ppsBytes.length >>> 8) & 0xff;
  config[offset + 2] = ppsBytes.length & 0xff;
  config.set(ppsBytes, offset + 3);
  return config;
}

export function codecStringFromSPS(sps) {
  const bytes = stripEmulationPrevention(sps);
  const profile = (bytes[1] ?? 0x42).toString(16).padStart(2, "0");
  const constraints = (bytes[2] ?? 0).toString(16).padStart(2, "0");
  const level = (bytes[3] ?? 0x1f).toString(16).padStart(2, "0");
  return `avc1.${profile}${constraints}${level}`.toLowerCase();
}

export function parseSPSDimensions(sps) {
  try {
    const bytes = stripEmulationPrevention(sps);
    const reader = new BitReader(bytes.subarray(4)); // skip NAL header + profile/compat/level
    const profile = bytes[1];
    reader.ue(); // seq_parameter_set_id
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      const chroma = reader.ue();
      if (chroma === 3) reader.u(1);
      reader.ue();
      reader.ue();
      reader.u(1);
      if (reader.u(1)) {
        const count = chroma !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (reader.u(1)) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }
    reader.ue(); // log2_max_frame_num_minus4
    const pocType = reader.ue();
    if (pocType === 0) {
      reader.ue();
    } else if (pocType === 1) {
      reader.u(1);
      reader.se();
      reader.se();
      const cycle = reader.ue();
      for (let i = 0; i < cycle; i++) reader.se();
    }
    reader.ue(); // max_num_ref_frames
    reader.u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = reader.ue() + 1;
    const heightMapUnits = reader.ue() + 1;
    const frameMbsOnly = reader.u(1);
    if (!frameMbsOnly) reader.u(1);
    reader.u(1); // direct_8x8_inference_flag
    let width = widthMbs * 16;
    let height = (2 - frameMbsOnly) * heightMapUnits * 16;
    if (reader.u(1)) {
      const left = reader.ue();
      const right = reader.ue();
      const top = reader.ue();
      const bottom = reader.ue();
      width -= (left + right) * 2;
      height -= (top + bottom) * 2 * (2 - frameMbsOnly);
    }
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // Fall through to the widely compatible default.
  }
  return { width: 1280, height: 720 };
}

function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let i = 0; i < size; i++) {
    if (next !== 0) next = (last + reader.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function stripEmulationPrevention(nal) {
  if (!nal) return new Uint8Array(0);
  const bytes = nal instanceof Uint8Array ? nal : new Uint8Array(nal);
  const out = new Uint8Array(bytes.length);
  let zeros = 0;
  let offset = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[offset++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, offset);
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bit = 0;
  }

  u(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const index = this.bit >> 3;
      if (index >= this.bytes.length) throw new Error("SPS ended early");
      value = (value << 1) | ((this.bytes[index] >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }

  ue() {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros += 1;
      if (zeros > 31) throw new Error("invalid Exp-Golomb value");
    }
    return zeros === 0 ? 0 : (2 ** zeros - 1) + this.u(zeros);
  }

  se() {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -(value / 2);
  }
}
