// ScreenCaptureService.kt
// CourseMate — Android screen capture helper
//
// Android Chrome does not implement getDisplayMedia, so a phone cannot use the
// built-in web page. MediaProjection is the supported path: this foreground
// service grabs the screen, hashes it, and POSTs JPEG frames to CourseMate.
//
// Setup
// ─────
//  1. Empty Android Studio project, minSdk 29.
//  2. Add this file plus the manifest entries:
//       <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
//       <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"/>
//       <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
//       <service android:name=".ScreenCaptureService"
//                android:foregroundServiceType="mediaProjection" android:exported="false"/>
//  3. From an Activity, request the projection, create a session, then start:
//       val mgr = getSystemService(MediaProjectionManager::class.java)
//       startActivityForResult(mgr.createScreenCaptureIntent(), RC_PROJECTION)
//     ...in onActivityResult:
//       ScreenCaptureService.start(this, resultCode, data!!.also { it }, course = "CS 101")
//
package com.example.coursemate

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class ScreenCaptureService : Service() {

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_COURSE = "course"
        const val EXTRA_BASE_URL = "baseUrl"
        const val EXTRA_TOKEN = "token"

        /** 2.5s between uploads keeps a long lecture cheap. */
        private const val FRAME_INTERVAL_MS = 2500L
        private const val TARGET_WIDTH = 1280
        private const val HASH_THRESHOLD = 2

        fun start(context: Context, resultCode: Int, data: Intent, course: String,
                  baseUrl: String, token: String = "") {
            val i = Intent(context, ScreenCaptureService::class.java).apply {
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
                putExtra(EXTRA_COURSE, course)
                putExtra(EXTRA_BASE_URL, baseUrl)
                putExtra(EXTRA_TOKEN, token)
            }
            context.startForegroundService(i)
        }
    }

    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var reader: ImageReader? = null

    private lateinit var baseUrl: String
    private var token: String = ""
    private var sessionId: String? = null
    private var lastHash: Long = 0
    private val handler = Handler(Looper.getMainLooper())

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(1, notification())
        baseUrl = intent?.getStringExtra(EXTRA_BASE_URL) ?: "http://127.0.0.1:8790"
        token = intent?.getStringExtra(EXTRA_TOKEN) ?: ""
        val course = intent?.getStringExtra(EXTRA_COURSE) ?: "Android course"

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        if (resultData == null) { stopSelf(); return START_NOT_STICKY }

        val mgr = getSystemService(MediaProjectionManager::class.java)
        projection = mgr.getMediaProjection(resultCode, resultData)

        createSession(course)
        startCapture()
        return START_STICKY
    }

    private fun createSession(course: String) {
        thread {
            try {
                val body = JSONObject().put("course", course).toString()
                val resp = post("/api/session", body)
                sessionId = JSONObject(resp).optString("session_id")
            } catch (e: Exception) {
                stopSelf()
            }
        }
    }

    private fun startCapture() {
        val metrics = resources.displayMetrics
        val height = (TARGET_WIDTH * metrics.heightPixels / metrics.widthPixels.toFloat()).toInt()

        reader = ImageReader.newInstance(TARGET_WIDTH, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = projection?.createVirtualDisplay(
            "coursemate", TARGET_WIDTH, height, metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader?.surface, null, null
        )

        reader?.setOnImageAvailableListener({ r ->
            val image = r.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val plane = image.planes[0]
                val rowStride = plane.rowStride
                val pixelStride = plane.pixelStride
                val rowPadding = rowStride - pixelStride * image.width
                val bmp = Bitmap.createBitmap(
                    image.width + rowPadding / pixelStride, image.height, Bitmap.Config.ARGB_8888
                )
                bmp.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bmp, 0, 0, image.width, image.height)

                val hash = averageHash(cropped)
                if (lastHash != 0L && java.lang.Long.bitCount(hash xor lastHash) <= HASH_THRESHOLD) return
                lastHash = hash

                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 70, out)
                val b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)

                val sid = sessionId ?: return
                thread {
                    val payload = JSONObject()
                        .put("session_id", sid)
                        .put("image_b64", b64)
                        .put("mime", "image/jpeg")
                        .put("hash", java.lang.Long.toHexString(hash))
                        .toString()
                    runCatching { post("/api/ingest/frame", payload) }
                }
            } finally {
                image.close()
            }
        }, handler)

        // Throttle: sample on an interval rather than on every frame.
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (projection == null) return
                handler.postDelayed(this, FRAME_INTERVAL_MS)
            }
        }, FRAME_INTERVAL_MS)
    }

    /** 8x8 grey average hash, packed into a Long. */
    private fun averageHash(src: Bitmap): Long {
        val small = Bitmap.createScaledBitmap(src, 8, 8, false)
        val px = IntArray(64)
        small.getPixels(px, 0, 8, 0, 0, 8, 8)
        var sum = 0L
        val grey = LongArray(64) {
            val p = px[it]
            val v = ((p shr 16 and 0xFF) * 299 + (p shr 8 and 0xFF) * 587 + (p and 0xFF) * 114) / 1000
            sum += v
            v.toLong()
        }
        val avg = sum / 64
        var hash = 0L
        for (i in 0 until 64) if (grey[i] > avg) hash = hash or (1L shl i)
        return hash
    }

    private fun post(path: String, body: String): String {
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.setRequestProperty("Content-Type", "application/json")
        if (token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toByteArray()) }
        val text = conn.inputStream.bufferedReader().readText()
        conn.disconnect()
        return text
    }

    private fun notification(): Notification {
        val channelId = "coursemate"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val mgr = getSystemService(NotificationManager::class.java)
            mgr.createNotificationChannel(
                NotificationChannel(channelId, "Course capture", NotificationManager.IMPORTANCE_LOW)
            )
        }
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("CourseMate is watching")
            .setContentText("Screen frames are being analysed on your server")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        virtualDisplay?.release()
        reader?.close()
        projection?.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?) = null
}
