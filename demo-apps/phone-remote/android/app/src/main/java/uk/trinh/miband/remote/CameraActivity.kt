package uk.trinh.miband.remote

import android.Manifest
import android.content.ContentValues
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Full-screen camera. While it is in front, the band's Shutter button takes a photo here (saved to
 * Pictures/MiBand Remote). Android only lets the foreground app use the camera, so this screen has to stay open.
 */
class CameraActivity : ComponentActivity() {
    private lateinit var preview: PreviewView
    private lateinit var flash: View
    private var capture: ImageCapture? = null
    private var back = true

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) bind() else finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = FrameLayout(this)
        preview = PreviewView(this)
        flash = View(this).apply { setBackgroundColor(Color.WHITE); alpha = 0f }
        val shoot = Button(this).apply { text = "Take photo"; setOnClickListener { takePhoto() } }
        val flip = Button(this).apply { text = "Flip"; setOnClickListener { back = !back; bind() } }
        root.addView(preview)
        root.addView(flash)
        root.addView(shoot, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = 48 })
        root.addView(flip, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { bottomMargin = 48; marginEnd = 24 })
        setContentView(root)
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) bind()
        else askCamera.launch(Manifest.permission.CAMERA)
    }

    override fun onResume() {
        super.onResume()
        Shutter.handler = { runOnUiThread { takePhoto() } }
        Hub.setCamera(true)
    }

    override fun onPause() {
        Shutter.handler = null
        Hub.setCamera(false)
        super.onPause()
    }

    private fun bind() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val p = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            val c = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
            val selector = if (back) CameraSelector.DEFAULT_BACK_CAMERA else CameraSelector.DEFAULT_FRONT_CAMERA
            provider.unbindAll()
            provider.bindToLifecycle(this, selector, p, c)
            capture = c
        }, ContextCompat.getMainExecutor(this))
    }

    private fun takePhoto() {
        val c = capture ?: return
        flash.alpha = 0.8f
        flash.animate().alpha(0f).setDuration(250).start()
        val name = "MiBandRemote_" + SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/MiBand Remote")
        }
        val output = ImageCapture.OutputFileOptions
            .Builder(contentResolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            .build()
        c.takePicture(output, ContextCompat.getMainExecutor(this), object : ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(result: ImageCapture.OutputFileResults) = Hub.log("Photo saved: $name")
            override fun onError(e: ImageCaptureException) = Hub.log("Photo failed: ${e.message}")
        })
    }
}
