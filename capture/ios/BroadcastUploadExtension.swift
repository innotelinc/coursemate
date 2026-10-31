//
//  SampleHandler.swift
//  CourseMate Broadcast Upload Extension
//
//  iOS has no way to capture the screen from a web page or a background app.
//  A ReplayKit broadcast extension is the supported path: the user starts it
//  from Control Centre, and iOS hands this process every frame and the app
//  audio. We downsample frames, skip duplicates and POST them to CourseMate.
//
//  Setup
//  ─────
//  1. New project -> add target -> Broadcast Upload Extension.
//  2. Replace the generated SampleHandler.swift with this file.
//  3. Enable an App Group on both targets, and store the server URL and the
//     session id under those keys from the host app:
//        UserDefaults(suiteName: "group.com.you.coursemate")
//          .set("http://192.168.1.20:8790", forKey: "cm_url")
//          .set(sessionId, forKey: "cm_session")
//          .set(token, forKey: "cm_token")        // only if COURSEMATE_TOKEN is set
//  4. Run on device. Control Centre -> long-press the record control -> CourseMate.
//
import ReplayKit
import CoreImage
import UIKit

final class SampleHandler: RPBroadcastSampleHandler {
    private let appGroup = "group.com.you.coursemate"
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    private var baseURL = ""
    private var sessionId = ""
    private var token = ""

    /// Minimum gap between uploads. One frame per 2.5 s matches the web client.
    private let minFrameInterval: TimeInterval = 2.5
    private var lastFrameAt: Date = .distantPast

    /// Skip uploads whose 8x8 average hash is within this distance of the last.
    private let hashThreshold = 2
    private var lastHash: UInt64 = 0

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let defaults = UserDefaults(suiteName: appGroup)
        baseURL = defaults?.string(forKey: "cm_url") ?? ""
        sessionId = defaults?.string(forKey: "cm_session") ?? ""
        token = defaults?.string(forKey: "cm_token") ?? ""
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with type: RPSampleBufferType) {
        switch type {
        case .video:
            maybeUploadFrame(sampleBuffer)
        case .audioApp, .audioMic:
            maybeUploadAudio(sampleBuffer)
        @unknown default:
            break
        }
    }

    // MARK: - Video

    private func maybeUploadFrame(_ buffer: CMSampleBuffer) {
        let now = Date()
        guard now.timeIntervalSince(lastFrameAt) >= minFrameInterval else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(buffer) else { return }

        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let targetWidth: CGFloat = 1280
        let scale = min(1, targetWidth / ciImage.extent.width)
        let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        guard let cgImage = ciContext.createCGImage(scaled, from: scaled.extent) else { return }
        let hash = averageHash(cgImage)
        if lastHash != 0 {
            let distance = (hash ^ lastHash).nonzeroBitCount
            if distance <= hashThreshold { return }
        }
        guard let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.7) else { return }

        lastFrameAt = now
        lastHash = hash
        upload(path: "/api/ingest/frame", payload: [
            "session_id": sessionId,
            "image_b64": jpeg.base64EncodedString(),
            "mime": "image/jpeg",
            "hash": String(hash, radix: 16),
        ])
    }

    /// 8x8 grey average hash, packed into 64 bits.
    private func averageHash(_ image: CGImage) -> UInt64 {
        let size = 8
        var pixels = [UInt8](repeating: 0, count: size * size)
        guard let space = CGColorSpace(name: CGColorSpace.linearGray) else { return 0 }
        guard let ctx = CGContext(
            data: &pixels, width: size, height: size,
            bitsPerComponent: 8, bytesPerRow: size, space: space,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return 0 }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))

        let average = pixels.reduce(0) { $0 + Int($1) } / (size * size)
        var hash: UInt64 = 0
        for (i, p) in pixels.enumerated() where Int(p) > average {
            hash |= 1 << UInt64(i)
        }
        return hash
    }

    // MARK: - Audio

    private var audioBuffer = Data()
    private var lastAudioFlush = Date()

    /// Accumulate roughly 12 seconds of PCM, then ship it. Whisper handles the
    /// container on the server side; we send raw 16-bit mono.
    private func maybeUploadAudio(_ buffer: CMSampleBuffer) {
        guard sessionId.isEmpty == false else { return }
        guard let block = CMSampleBufferGetDataBuffer(buffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let bytes = pointer else { return }
        audioBuffer.append(UnsafeBufferPointer(start: UnsafePointer<UInt8>(bytes), count: length))

        if Date().timeIntervalSince(lastAudioFlush) >= 12 {
            lastAudioFlush = Date()
            let chunk = audioBuffer
            audioBuffer = Data()
            guard chunk.count > 4000 else { return }
            upload(path: "/api/ingest/audio", payload: [
                "session_id": sessionId,
                "audio_b64": chunk.base64EncodedString(),
                "mime": "audio/wav",
            ])
        }
    }

    // MARK: - Transport

    private func upload(path: String, payload: [String: Any]) {
        guard let url = URL(string: baseURL + path) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { _, _, _ in
            // Best effort: a dropped frame is cheaper than a stalled broadcast.
        }.resume()
    }
}
