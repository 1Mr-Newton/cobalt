import HLS from "hls-parser";

import { fetch } from "undici";

import { env } from "../../config.js";

const codecList = {
  h264: {
    videoCodec: "avc1",
    audioCodec: "mp4a",
    container: "mp4",
  },
  av1: {
    videoCodec: "av01",
    audioCodec: "opus",
    container: "webm",
  },
  vp9: {
    videoCodec: "vp9",
    audioCodec: "opus",
    container: "webm",
  },
};

const hlsCodecList = {
  h264: {
    videoCodec: "avc1",
    audioCodec: "mp4a",
    container: "mp4",
  },
  vp9: {
    videoCodec: "vp09",
    audioCodec: "mp4a",
    container: "webm",
  },
};

const videoQualities = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

const fetchVideoInfo = async (videoId, dispatcher) => {
  const response = await fetch(
    "https://youtubei.googleapis.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
    {
      method: "POST",
      headers: {
        "X-YouTube-Client-Name": "WEB",
        "X-YouTube-Client-Version": "2.20230728.00.00",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "19.17.34",
          },
        },
        videoId: videoId,
      }),
      dispatcher,
    }
  );

  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status}`);
  }

  const data = await response.json();

  // Map YouTube API response to the format expected by the rest of the code
  const adaptiveFormats = (data.streamingData?.adaptiveFormats || []).map(
    (format) => ({
      itag: format.itag,
      url: format.url,
      mime_type: format.mimeType,
      bitrate: format.bitrate,
      width: format.width,
      height: format.height,
      content_length: format.contentLength,
      quality: format.quality,
      quality_label: format.qualityLabel,
      has_video: format.mimeType?.startsWith("video/"),
      has_audio: format.mimeType?.startsWith("audio/"),
      audio_quality: format.audioQuality,
      audio_sample_rate: format.audioSampleRate,
      audio_channels: format.audioChannels,
      language: format.audioTrack?.displayName,
      audio_track: format.audioTrack,
      is_original: format.audioTrack?.audioIsDefault,
      drm_families: format.drmFamilies,
    })
  );

  return {
    playability_status: {
      status: data.playabilityStatus?.status,
      reason: data.playabilityStatus?.reason,
      error_screen: data.playabilityStatus?.errorScreen,
    },
    basic_info: {
      id: data.videoDetails?.videoId,
      title: data.videoDetails?.title,
      author: data.videoDetails?.author,
      duration: parseInt(data.videoDetails?.lengthSeconds) || 0,
      is_live: data.videoDetails?.isLiveContent,
      short_description: data.videoDetails?.shortDescription,
      thumbnail: data.videoDetails?.thumbnail?.thumbnails,
    },
    streaming_data: {
      adaptive_formats: adaptiveFormats,
      hls_manifest_url: data.streamingData?.hlsManifestUrl,
    },
    captions: {
      caption_tracks: (
        data.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
      ).map((track) => ({
        base_url: track.baseUrl,
        language_code: track.languageCode,
        kind: track.kind,
      })),
    },
  };
};

const getHlsVariants = async (hlsManifest, dispatcher) => {
  if (!hlsManifest) {
    return { error: "youtube.no_hls_streams" };
  }

  const fetchedHlsManifest = await fetch(hlsManifest, { dispatcher })
    .then((r) => (r.status === 200 ? r.text() : undefined))
    .catch(() => {});

  if (!fetchedHlsManifest) {
    return { error: "youtube.no_hls_streams" };
  }

  const variants = HLS.parse(fetchedHlsManifest).variants.sort(
    (a, b) => Number(b.bandwidth) - Number(a.bandwidth)
  );

  if (!variants || variants.length === 0) {
    return { error: "youtube.no_hls_streams" };
  }

  return variants;
};

const getSubtitles = async (info, dispatcher, subtitleLang) => {
  const preferredCap = info.captions.caption_tracks.find(
    (caption) =>
      caption.kind !== "asr" && caption.language_code.startsWith(subtitleLang)
  );

  const captionsUrl = preferredCap?.base_url;
  if (!captionsUrl) return;

  if (!captionsUrl.includes("exp=xpe")) {
    let url = new URL(captionsUrl);
    url.searchParams.set("fmt", "vtt");

    return {
      url: url.toString(),
      language: preferredCap.language_code,
    };
  }

  // if we have exp=xpe in the url, then captions are
  // locked down and can't be accessed without a yummy potoken,
  // so instead we just use subtitles from HLS

  const hlsVariants = await getHlsVariants(
    info.streaming_data.hls_manifest_url,
    dispatcher
  );
  if (hlsVariants?.error) return;

  // all variants usually have the same set of subtitles
  const hlsSubtitles = hlsVariants[0]?.subtitles;
  if (!hlsSubtitles?.length) return;

  const preferredHls = hlsSubtitles.find((subtitle) =>
    subtitle.language.startsWith(subtitleLang)
  );

  if (!preferredHls) return;

  const fetchedHlsSubs = await fetch(preferredHls.uri, { dispatcher })
    .then((r) => (r.status === 200 ? r.text() : undefined))
    .catch(() => {});

  const parsedSubs = HLS.parse(fetchedHlsSubs);
  if (!parsedSubs) return;

  return {
    url: parsedSubs.segments[0]?.uri,
    language: preferredHls.language,
  };
};

export default async function (o) {
  const quality = o.quality === "max" ? 9000 : Number(o.quality);

  let useHLS = o.youtubeHLS;
  const innertubeClient = "ANDROID";

  // HLS playlists from the Android client don't contain the av1 video format.
  if (useHLS && o.codec === "av1") {
    useHLS = false;
  }

  let info;
  try {
    info = await fetchVideoInfo(o.id, o.dispatcher);
  } catch (e) {
    if (e?.message?.includes("403") || e?.message?.includes("401")) {
      return { error: "youtube.api_error" };
    }
    return { error: "fetch.fail" };
  }

  if (!info) return { error: "fetch.fail" };

  const playability = info.playability_status;
  const basicInfo = info.basic_info;

  switch (playability.status) {
    case "LOGIN_REQUIRED":
      if (playability.reason.endsWith("bot")) {
        return { error: "youtube.login" };
      }
      if (
        playability.reason.endsWith("age") ||
        playability.reason.endsWith("inappropriate for some users.")
      ) {
        return { error: "content.video.age" };
      }
      if (playability?.error_screen?.reason?.text === "Private video") {
        return { error: "content.video.private" };
      }
      break;

    case "UNPLAYABLE":
      if (playability?.reason?.endsWith("request limit.")) {
        return { error: "fetch.rate" };
      }
      if (
        playability?.error_screen?.subreason?.text?.endsWith("in your country")
      ) {
        return { error: "content.video.region" };
      }
      if (playability?.error_screen?.reason?.text === "Private video") {
        return { error: "content.video.private" };
      }
      break;

    case "AGE_VERIFICATION_REQUIRED":
      return { error: "content.video.age" };
  }

  if (playability.status !== "OK") {
    return { error: "content.video.unavailable" };
  }

  if (basicInfo.is_live) {
    return { error: "content.video.live" };
  }

  if (basicInfo.duration > env.durationLimit) {
    return { error: "content.too_long" };
  }

  // return a critical error if returned video is "Video Not Available"
  // or a similar stub by youtube
  if (basicInfo.id !== o.id) {
    return {
      error: "fetch.fail",
      critical: true,
    };
  }

  const normalizeQuality = (res) => {
    const shortestSide = Math.min(res.height, res.width);
    return videoQualities.find((qual) => qual >= shortestSide);
  };

  let video,
    audio,
    subtitles,
    dubbedLanguage,
    codec = o.codec || "h264",
    itag = o.itag;

  if (useHLS) {
    const variants = await getHlsVariants(
      info.streaming_data.hls_manifest_url,
      o.dispatcher
    );

    if (variants?.error) return variants;

    const matchHlsCodec = (codecs) =>
      codecs.includes(hlsCodecList[codec].videoCodec);

    const best = variants.find((i) => matchHlsCodec(i.codecs));

    const preferred = variants.find(
      (i) =>
        matchHlsCodec(i.codecs) && normalizeQuality(i.resolution) === quality
    );

    let selected = preferred || best;

    if (!selected) {
      codec = "h264";
      selected = variants.find((i) => matchHlsCodec(i.codecs));
    }

    if (!selected) {
      return { error: "youtube.no_matching_format" };
    }

    audio = selected.audio.find((i) => i.isDefault);

    // some videos (mainly those with AI dubs) don't have any tracks marked as default
    // why? god knows, but we assume that a default track is marked as such in the title
    if (!audio) {
      audio = selected.audio.find((i) => i.name.endsWith("original"));
    }

    if (o.dubLang) {
      const dubbedAudio = selected.audio.find((i) =>
        i.language?.startsWith(o.dubLang)
      );

      if (dubbedAudio && !dubbedAudio.isDefault) {
        dubbedLanguage = dubbedAudio.language;
        audio = dubbedAudio;
      }
    }

    selected.audio = [];
    selected.subtitles = [];
    video = selected;
  } else {
    // i miss typescript so bad
    const sorted_formats = {
      h264: {
        video: [],
        audio: [],
        bestVideo: undefined,
        bestAudio: undefined,
      },
      vp9: {
        video: [],
        audio: [],
        bestVideo: undefined,
        bestAudio: undefined,
      },
      av1: {
        video: [],
        audio: [],
        bestVideo: undefined,
        bestAudio: undefined,
      },
    };

    const checkFormat = (format, pCodec) =>
      format.content_length &&
      (format.mime_type.includes(codecList[pCodec].videoCodec) ||
        format.mime_type.includes(codecList[pCodec].audioCodec));

    // sort formats & weed out bad ones
    info.streaming_data.adaptive_formats
      .sort((a, b) => Number(b.bitrate) - Number(a.bitrate))
      .forEach((format) => {
        Object.keys(codecList).forEach((yCodec) => {
          const matchingItag = (slot) =>
            !itag?.[slot] || itag[slot] === format.itag;
          const sorted = sorted_formats[yCodec];
          const goodFormat = checkFormat(format, yCodec);
          if (!goodFormat) return;

          if (format.has_video && matchingItag("video")) {
            sorted.video.push(format);
            if (!sorted.bestVideo) sorted.bestVideo = format;
          }

          if (format.has_audio && matchingItag("audio")) {
            sorted.audio.push(format);
            if (!sorted.bestAudio) sorted.bestAudio = format;
          }
        });
      });

    const noBestMedia = () => {
      const vid = sorted_formats[codec]?.bestVideo;
      const aud = sorted_formats[codec]?.bestAudio;
      return (!vid && !o.isAudioOnly) || (!aud && o.isAudioOnly);
    };

    if (noBestMedia()) {
      if (codec === "av1") codec = "vp9";
      else if (codec === "vp9") codec = "av1";

      // if there's no higher quality fallback, then use h264
      if (noBestMedia()) codec = "h264";
    }

    // if there's no proper combo of av1, vp9, or h264, then give up
    if (noBestMedia()) {
      return { error: "youtube.no_matching_format" };
    }

    audio = sorted_formats[codec].bestAudio;

    if (audio?.audio_track && !audio?.is_original) {
      audio = sorted_formats[codec].audio.find((i) => i?.is_original);
    }

    if (o.dubLang) {
      const dubbedAudio = sorted_formats[codec].audio.find(
        (i) => i.language?.startsWith(o.dubLang) && i.audio_track
      );

      if (dubbedAudio && !dubbedAudio?.is_original) {
        audio = dubbedAudio;
        dubbedLanguage = dubbedAudio.language;
      }
    }

    if (!o.isAudioOnly) {
      const qual = (i) => {
        return normalizeQuality({
          width: i.width,
          height: i.height,
        });
      };

      const bestQuality = qual(sorted_formats[codec].bestVideo);
      const useBestQuality = quality >= bestQuality;

      video = useBestQuality
        ? sorted_formats[codec].bestVideo
        : sorted_formats[codec].video.find((i) => qual(i) === quality);

      if (!video) video = sorted_formats[codec].bestVideo;
    }

    if (
      o.subtitleLang &&
      !o.isAudioOnly &&
      info.captions?.caption_tracks?.length
    ) {
      const videoSubtitles = await getSubtitles(
        info,
        o.dispatcher,
        o.subtitleLang
      );
      if (videoSubtitles) {
        subtitles = videoSubtitles;
      }
    }
  }

  if (video?.drm_families || audio?.drm_families) {
    return { error: "youtube.drm" };
  }

  const fileMetadata = {
    title: basicInfo.title.trim(),
    artist: basicInfo.author.replace("- Topic", "").trim(),
  };

  if (basicInfo?.short_description?.startsWith("Provided to YouTube by")) {
    const descItems = basicInfo.short_description.split("\n\n", 5);

    if (descItems.length === 5) {
      fileMetadata.album = descItems[2];
      fileMetadata.copyright = descItems[3];
      if (descItems[4].startsWith("Released on:")) {
        fileMetadata.date = descItems[4].replace("Released on: ", "").trim();
      }
    }
  }

  if (subtitles) {
    fileMetadata.sublanguage = subtitles.language;
  }

  const filenameAttributes = {
    service: "youtube",
    id: o.id,
    title: fileMetadata.title,
    author: fileMetadata.artist,
    youtubeDubName: dubbedLanguage || false,
  };

  itag = {
    video: video?.itag,
    audio: audio?.itag,
  };

  const originalRequest = {
    ...o,
    dispatcher: undefined,
    itag,
    innertubeClient,
  };

  if (audio && o.isAudioOnly) {
    let bestAudio = codec === "h264" ? "m4a" : "opus";
    let urls = audio.url;

    if (useHLS) {
      bestAudio = "mp3";
      urls = audio.uri;
    }

    let cover = `https://i.ytimg.com/vi/${o.id}/maxresdefault.jpg`;
    const testMaxCover = await fetch(cover, { dispatcher: o.dispatcher })
      .then((r) => r.status === 200)
      .catch(() => {});

    if (!testMaxCover) {
      cover = basicInfo.thumbnail?.[0]?.url;
    }

    return {
      type: "audio",
      isAudioOnly: true,
      urls,
      filenameAttributes,
      fileMetadata,
      bestAudio,
      isHLS: useHLS,
      originalRequest,
      cover,
      cropCover: basicInfo.author.endsWith("- Topic"),
    };
  }

  if (video && audio) {
    let resolution;

    if (useHLS) {
      resolution = normalizeQuality(video.resolution);
      filenameAttributes.resolution = `${video.resolution.width}x${video.resolution.height}`;
      filenameAttributes.extension =
        o.container === "auto" ? hlsCodecList[codec].container : o.container;

      video = video.uri;
      audio = audio.uri;
    } else {
      resolution = normalizeQuality({
        width: video.width,
        height: video.height,
      });

      filenameAttributes.resolution = `${video.width}x${video.height}`;
      filenameAttributes.extension =
        o.container === "auto" ? codecList[codec].container : o.container;

      video = video.url;
      audio = audio.url;
    }

    filenameAttributes.qualityLabel = `${resolution}p`;
    filenameAttributes.youtubeFormat = codec;

    return {
      type: "merge",
      urls: [video, audio],
      subtitles: subtitles?.url,
      filenameAttributes,
      fileMetadata,
      isHLS: useHLS,
      originalRequest,
    };
  }

  return { error: "youtube.no_matching_format" };
}
