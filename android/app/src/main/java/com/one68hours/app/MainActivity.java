package com.one68hours.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

public final class MainActivity extends Activity {
    private static final String START_URL = "file:///android_asset/index.html";
    private static final String ASSET_PREFIX = "file:///android_asset/";
    private static final int REQUEST_CREATE_JSON = 16801;
    private static final int REQUEST_OPEN_JSON = 16802;
    private static final int REQUEST_NOTIFICATION_PERMISSION = 16803;
    private static final int MAX_JSON_BYTES = 10 * 1024 * 1024;
    private static final String STATE_EXPORT_PENDING = "state_export_pending";
    private static final String STATE_IMPORT_PENDING = "state_import_pending";
    private static final String EXPORT_CACHE_FILE = "pending-export.json";
    private static final String IMPORT_CACHE_FILE = "pending-import.json";

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private AiImportService aiImportService;
    private FrameLayout webContainer;
    private WebView webView;
    private boolean exportPending;
    private boolean exportPrepareInFlight;
    private boolean exportWriteInFlight;
    private boolean importPending;
    private boolean importPickerPending;
    private boolean importReadInFlight;
    private boolean importDeliveryInFlight;
    private int importDeliveryRetries;
    private boolean pageReady;
    private String pendingImportedJson;
    private boolean backDispatchPending;
    private boolean darkSystemTheme;
    private boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Editions without text recognition never create the service; their
        // manifest also omits INTERNET, so no request can leave the device.
        aiImportService = Edition.AI_IMPORT ? new AiImportService(this) : null;
        if (savedInstanceState == null) {
            clearPendingExport();
        } else {
            exportPending = savedInstanceState.getBoolean(STATE_EXPORT_PENDING, false)
                    && exportCacheFile().isFile();
        }
        importPending = importCacheFile().isFile()
                && (savedInstanceState == null
                || savedInstanceState.getBoolean(STATE_IMPORT_PENDING, true));
        configureSystemBars(isSystemDark());
        NotificationHelper.ensureChannel(this);
        createWebView();
        webView.loadUrl(START_URL);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean(STATE_EXPORT_PENDING, exportPending);
        outState.putBoolean(
                STATE_IMPORT_PENDING,
                importPending || importCacheFile().isFile()
        );
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        configureSystemBars(darkSystemTheme);
        if (Build.VERSION.SDK_INT >= 35 && webContainer != null) {
            webContainer.requestApplyInsets();
        }
        // uiMode is handled in place, so the light AppTheme keeps the WebView's
        // prefers-color-scheme at "light"; tell the page about the system theme.
        emitStringEvent("android-system-theme", isSystemDark() ? "dark" : "light");
    }

    private boolean isSystemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    private void configureSystemBars(boolean dark) {
        darkSystemTheme = dark;
        int barColor = dark
                ? Color.rgb(16, 22, 19)
                : Color.rgb(247, 248, 244);
        getWindow().setStatusBarColor(barColor);
        getWindow().setNavigationBarColor(barColor);
        if (webContainer != null) {
            webContainer.setBackgroundColor(barColor);
        }
        int flags = 0;
        if (!dark) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(darkSystemTheme
                ? Color.rgb(16, 22, 19)
                : Color.rgb(247, 248, 244));
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new OfflineWebViewClient());
        webView.addJavascriptInterface(new NativeBridge(), "AndroidBridge");

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setBlockNetworkLoads(true);
        settings.setBlockNetworkImage(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setGeolocationEnabled(false);
        settings.setSaveFormData(false);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setSupportZoom(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        CookieManager.getInstance().setAcceptCookie(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(false);

        webContainer = new FrameLayout(this);
        webContainer.setBackgroundColor(darkSystemTheme
                ? Color.rgb(16, 22, 19)
                : Color.rgb(247, 248, 244));
        webContainer.addView(
                webView,
                new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                )
        );
        if (Build.VERSION.SDK_INT >= 35) {
            Api35Insets.apply(webContainer);
        }

        setContentView(webContainer);
        if (Build.VERSION.SDK_INT >= 35) {
            webContainer.post(new Runnable() {
                @Override
                public void run() {
                    if (webContainer != null) {
                        webContainer.requestApplyInsets();
                    }
                }
            });
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        if (ReminderScheduler.isEnabled(this)
                && !NotificationHelper.canPostNotifications(this)) {
            ReminderScheduler.disable(this);
            emitStringEvent("android-reminder-permission", "denied");
            emitStringEvent("android-reminder-updated", "off");
        }
        if (!importPending && importCacheFile().isFile()) {
            importPending = true;
        }
        maybeDeliverPendingImport();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        ioExecutor.shutdown();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (backDispatchPending) {
            return;
        }
        backDispatchPending = true;
        String script = "(function(){try{"
                + "return typeof window.handleAndroidBack==='function'"
                + "&&Boolean(window.handleAndroidBack());"
                + "}catch(error){return false;}})();";
        webView.evaluateJavascript(script, new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String result) {
                backDispatchPending = false;
                if ("true".equalsIgnoreCase(result)) {
                    return;
                }
                finishAfterWebBack();
            }
        });
    }

    private void finishAfterWebBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CREATE_JSON) {
            handleExportResult(resultCode, data);
        } else if (requestCode == REQUEST_OPEN_JSON) {
            handleImportResult(resultCode, data);
        }
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_NOTIFICATION_PERMISSION) {
            return;
        }
        boolean granted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            ReminderScheduler.rescheduleStored(this);
            showToast("提醒通知已允许");
            emitStringEvent("android-reminder-permission", "granted");
            emitStringEvent("android-reminder-updated", reminderTimeFromState());
        } else {
            ReminderScheduler.disable(this);
            showToast("未开启通知权限，每日提醒保持关闭");
            emitStringEvent("android-reminder-permission", "denied");
            emitStringEvent("android-reminder-updated", "off");
        }
    }

    private void startExport(String json) {
        if (isSafOperationInFlight()) {
            showToast("已有备份操作正在进行");
            emitStringEvent("android-export-error", "operation_in_flight");
            return;
        }
        exportPrepareInFlight = true;
        boolean submitted = submitIo(new Runnable() {
            @Override
            public void run() {
                if (!isValidJsonDocument(json)) {
                    postToUi(new Runnable() {
                        @Override
                        public void run() {
                            exportPrepareInFlight = false;
                            showToast("备份数据格式不正确，未导出");
                            emitStringEvent("android-export-error", "invalid_json");
                        }
                    });
                    return;
                }
                try {
                    writePendingExport(json);
                } catch (IOException | SecurityException error) {
                    deletePendingExportFile();
                    postToUi(new Runnable() {
                        @Override
                        public void run() {
                            exportPrepareInFlight = false;
                            showToast("暂时无法准备备份，请重试");
                            emitStringEvent("android-export-error", "cache_failed");
                        }
                    });
                    return;
                }
                postToUi(new Runnable() {
                    @Override
                    public void run() {
                        exportPrepareInFlight = false;
                        exportPending = true;
                        launchExportPicker();
                    }
                });
            }
        });
        if (!submitted) {
            exportPrepareInFlight = false;
            showToast("暂时无法准备备份，请重试");
            emitStringEvent("android-export-error", "worker_unavailable");
        }
    }

    private void launchExportPicker() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, defaultBackupName());
        try {
            startActivityForResult(intent, REQUEST_CREATE_JSON);
        } catch (ActivityNotFoundException error) {
            clearPendingExport();
            showToast("这台设备没有可用的文件选择器");
            emitStringEvent("android-export-error", "no_file_picker");
        }
    }

    private void startImport() {
        if (isSafOperationInFlight()) {
            showToast("已有导入操作正在处理");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/json", "text/json", "text/plain"
        });
        try {
            importPickerPending = true;
            startActivityForResult(intent, REQUEST_OPEN_JSON);
        } catch (ActivityNotFoundException error) {
            importPickerPending = false;
            showToast("这台设备没有可用的文件选择器");
            emitStringEvent("android-import-error", "no_file_picker");
        }
    }

    private void handleExportResult(int resultCode, Intent data) {
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            clearPendingExport();
            emitStringEvent("android-export-cancelled", "cancelled");
            return;
        }
        Uri destination = data.getData();
        exportPending = false;
        exportWriteInFlight = true;
        boolean submitted = submitIo(new Runnable() {
            @Override
            public void run() {
                boolean succeeded = false;
                try {
                    String json = readPendingExport();
                    if (!isValidJsonDocument(json)) {
                        throw new IOException("Pending export is no longer valid JSON");
                    }
                    try (OutputStream output = getContentResolver()
                            .openOutputStream(destination, "wt")) {
                        if (output == null) {
                            throw new IOException("Unable to open destination");
                        }
                        output.write(json.getBytes(StandardCharsets.UTF_8));
                        output.flush();
                    }
                    succeeded = true;
                } catch (IOException | SecurityException ignored) {
                    // The UI reports a stable error without exposing provider details.
                } finally {
                    deletePendingExportFile();
                }
                final boolean result = succeeded;
                postToUi(new Runnable() {
                    @Override
                    public void run() {
                        exportWriteInFlight = false;
                        if (result) {
                            showToast("备份已保存");
                            emitStringEvent("android-export-complete", "saved");
                        } else {
                            showToast("备份保存失败，请换一个位置重试");
                            emitStringEvent("android-export-error", "write_failed");
                        }
                    }
                });
            }
        });
        if (!submitted) {
            exportWriteInFlight = false;
            clearPendingExport();
            showToast("备份保存失败，请重试");
            emitStringEvent("android-export-error", "worker_unavailable");
        }
    }

    private void handleImportResult(int resultCode, Intent data) {
        importPickerPending = false;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            emitStringEvent("android-import-cancelled", "cancelled");
            return;
        }
        Uri source = data.getData();
        importReadInFlight = true;
        boolean submitted = submitIo(new Runnable() {
            @Override
            public void run() {
                String json;
                try {
                    json = readUtf8Json(source);
                    if (!isValidJsonDocument(json)) {
                        throw new JSONException("Root value must be a JSON object or array");
                    }
                    writePendingImport(json);
                } catch (IOException | JSONException | SecurityException error) {
                    deletePendingImportFile();
                    postToUi(new Runnable() {
                        @Override
                        public void run() {
                            importReadInFlight = false;
                            showToast("无法导入：请选择本应用导出的 JSON 备份");
                            emitStringEvent(
                                    "android-import-error",
                                    "invalid_or_unreadable_file"
                            );
                        }
                    });
                    return;
                }
                final String importedJson = json;
                postToUi(new Runnable() {
                    @Override
                    public void run() {
                        importReadInFlight = false;
                        importPending = true;
                        importDeliveryRetries = 0;
                        pendingImportedJson = importedJson;
                        maybeDeliverPendingImport();
                    }
                });
            }
        });
        if (!submitted) {
            importReadInFlight = false;
            showToast("暂时无法读取备份，请重试");
            emitStringEvent("android-import-error", "worker_unavailable");
        }
    }

    private String readUtf8Json(Uri source) throws IOException {
        try (InputStream input = getContentResolver().openInputStream(source)) {
            if (input == null) {
                throw new IOException("Unable to open source");
            }
            return readUtf8Json(input);
        }
    }

    private String readUtf8Json(InputStream input) throws IOException {
        try (ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_JSON_BYTES) {
                    throw new IOException("Backup is larger than the safety limit");
                }
                output.write(buffer, 0, read);
            }
            String result = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(output.toByteArray()))
                    .toString();
            if (!result.isEmpty() && result.charAt(0) == '\uFEFF') {
                result = result.substring(1);
            }
            return result;
        }
    }

    private void writePendingExport(String json) throws IOException {
        try (FileOutputStream output = new FileOutputStream(exportCacheFile(), false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }

    private String readPendingExport() throws IOException {
        if (!exportCacheFile().isFile()) {
            throw new IOException("No pending export");
        }
        try (FileInputStream input = new FileInputStream(exportCacheFile())) {
            return readUtf8Json(input);
        }
    }

    private File exportCacheFile() {
        return new File(getCacheDir(), EXPORT_CACHE_FILE);
    }

    private void clearPendingExport() {
        exportPending = false;
        deletePendingExportFile();
    }

    private void deletePendingExportFile() {
        File file = exportCacheFile();
        if (file.isFile()) {
            // The file lives in the app-private cache and contains a temporary copy only.
            file.delete();
        }
    }

    private void writePendingImport(String json) throws IOException {
        try (FileOutputStream output = new FileOutputStream(importCacheFile(), false)) {
            output.write(json.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
    }

    private String readPendingImport() throws IOException {
        if (!importCacheFile().isFile()) {
            throw new IOException("No pending import");
        }
        try (FileInputStream input = new FileInputStream(importCacheFile())) {
            return readUtf8Json(input);
        }
    }

    private File importCacheFile() {
        return new File(getNoBackupFilesDir(), IMPORT_CACHE_FILE);
    }

    private void clearPendingImport() {
        importPending = false;
        importDeliveryRetries = 0;
        pendingImportedJson = null;
        deletePendingImportFile();
    }

    private void deletePendingImportFile() {
        File file = importCacheFile();
        if (file.isFile()) {
            file.delete();
        }
    }

    private boolean isValidJsonDocument(String json) {
        if (json == null || json.isEmpty() || json.length() > MAX_JSON_BYTES) {
            return false;
        }
        if (json.getBytes(StandardCharsets.UTF_8).length > MAX_JSON_BYTES) {
            return false;
        }
        try {
            JSONTokener tokener = new JSONTokener(json);
            Object value = tokener.nextValue();
            if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) {
                return false;
            }
            return tokener.nextClean() == 0;
        } catch (JSONException error) {
            return false;
        }
    }

    private void maybeDeliverPendingImport() {
        if (!pageReady || webView == null || importDeliveryInFlight || importReadInFlight) {
            return;
        }
        if (pendingImportedJson != null) {
            deliverImportedJson(pendingImportedJson);
            return;
        }
        if (!importPending && !importCacheFile().isFile()) {
            return;
        }
        importPending = true;
        importReadInFlight = true;
        boolean submitted = submitIo(new Runnable() {
            @Override
            public void run() {
                String json;
                try {
                    json = readPendingImport();
                    if (!isValidJsonDocument(json)) {
                        throw new IOException("Pending import is no longer valid JSON");
                    }
                } catch (IOException | SecurityException error) {
                    deletePendingImportFile();
                    postToUi(new Runnable() {
                        @Override
                        public void run() {
                            importReadInFlight = false;
                            clearPendingImport();
                            showToast("待导入的备份已失效，请重新选择");
                            emitStringEvent("android-import-error", "pending_import_lost");
                        }
                    });
                    return;
                }
                final String importedJson = json;
                postToUi(new Runnable() {
                    @Override
                    public void run() {
                        importReadInFlight = false;
                        pendingImportedJson = importedJson;
                        if (pageReady) {
                            deliverImportedJson(importedJson);
                        }
                    }
                });
            }
        });
        if (!submitted) {
            importReadInFlight = false;
            showToast("暂时无法恢复待导入备份，请重试");
        }
    }

    private void deliverImportedJson(String json) {
        if (webView == null || !pageReady || importDeliveryInFlight) {
            return;
        }
        importDeliveryInFlight = true;
        boolean submitted = submitIo(new Runnable() {
            @Override
            public void run() {
                String quotedJson = quoteForJavascript(json);
                String script = "(function(){try{"
                        + "var raw=" + quotedJson + ";"
                        + "if(typeof window.receiveImportedData==='function'){"
                        + "window.receiveImportedData(raw);"
                        + "}else{window.dispatchEvent(new CustomEvent('android-import-complete',{detail:raw}));}"
                        + "return true;}catch(error){return false;}})();";
                postToUi(new Runnable() {
                    @Override
                    public void run() {
                        if (webView == null || !pageReady) {
                            importDeliveryInFlight = false;
                            return;
                        }
                        webView.evaluateJavascript(script, new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String result) {
                                if (destroyed) {
                                    return;
                                }
                                importDeliveryInFlight = false;
                                if ("true".equalsIgnoreCase(result)) {
                                    importDeliveryRetries = 0;
                                    clearPendingImport();
                                } else {
                                    importPending = true;
                                    if (importDeliveryRetries < 2) {
                                        importDeliveryRetries++;
                                        mainHandler.postDelayed(new Runnable() {
                                            @Override
                                            public void run() {
                                                maybeDeliverPendingImport();
                                            }
                                        }, 500L);
                                    } else {
                                        showToast(
                                                "导入页面暂未准备好，请重新打开应用后重试"
                                        );
                                    }
                                }
                            }
                        });
                    }
                });
            }
        });
        if (!submitted) {
            importDeliveryInFlight = false;
            showToast("暂时无法处理待导入备份，请重试");
        }
    }

    private static final String AI_DISABLED = "{\"ok\":false,\"message\":\"当前版本未启用文字识别\"}";

    private void emitAiDisabled(String eventName, String requestId) {
        final String payload = aiEventPayload(requestId, AI_DISABLED);
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!destroyed) emitStringEvent(eventName, payload);
            }
        });
    }

    private static String aiEventPayload(String requestId, String result) {
        try {
            return new JSONObject()
                    .put("requestId", requestId)
                    .put("result", new JSONObject(result))
                    .toString();
        } catch (JSONException ignored) {
            return "{}";
        }
    }

    private void emitStringEvent(String eventName, String value) {
        if (webView == null) {
            return;
        }
        String script = "window.dispatchEvent(new CustomEvent("
                + quoteForJavascript(eventName)
                + ",{detail:" + quoteForJavascript(value) + "}));";
        webView.evaluateJavascript(script, null);
    }

    private static String quoteForJavascript(String value) {
        return JSONObject.quote(value)
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029");
    }

    private boolean submitIo(Runnable work) {
        if (destroyed) {
            return false;
        }
        try {
            ioExecutor.execute(work);
            return true;
        } catch (RejectedExecutionException ignored) {
            return false;
        }
    }

    private boolean isSafOperationInFlight() {
        return exportPending
                || exportPrepareInFlight
                || exportWriteInFlight
                || importPending
                || importPickerPending
                || importReadInFlight
                || importDeliveryInFlight;
    }

    private void postToUi(Runnable action) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!destroyed) {
                    action.run();
                }
            }
        });
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATION_PERMISSION
            );
        }
    }

    private void openNotificationSettings() {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException ignored) {
            showToast("请在系统设置中为本应用开启通知");
        }
    }

    private void sharePlainText(String text) {
        if (text == null || text.trim().isEmpty()) {
            showToast("暂无内容可分享");
            return;
        }
        String safeText = text.length() > 100_000 ? text.substring(0, 100_000) : text;
        Intent shareIntent = new Intent(Intent.ACTION_SEND);
        shareIntent.setType("text/plain");
        shareIntent.putExtra(Intent.EXTRA_TEXT, safeText);
        try {
            startActivity(Intent.createChooser(shareIntent, "分享本周回顾"));
        } catch (ActivityNotFoundException error) {
            showToast("没有可用于分享的应用");
        }
    }

    private void showToast(String message) {
        String safeMessage = message == null ? "" : message.trim();
        if (safeMessage.isEmpty()) {
            return;
        }
        if (safeMessage.length() > 200) {
            safeMessage = safeMessage.substring(0, 200);
        }
        Toast.makeText(this, safeMessage, Toast.LENGTH_SHORT).show();
    }

    private String defaultBackupName() {
        String date = new SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).format(new Date());
        return Edition.BACKUP_FILE_PREFIX + date + ".json";
    }

    private boolean isAssetUrl(String url) {
        if (url == null || !url.startsWith(ASSET_PREFIX)) {
            return false;
        }
        Uri uri = Uri.parse(url);
        if (!"file".equalsIgnoreCase(uri.getScheme()) || uri.getHost() != null) {
            return false;
        }
        List<String> segments = uri.getPathSegments();
        return segments.size() >= 2
                && "android_asset".equals(segments.get(0))
                && !segments.contains("..");
    }

    private boolean isSafeSubresource(String url) {
        if (isAssetUrl(url)) {
            return true;
        }
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        return "data".equalsIgnoreCase(scheme)
                || "blob".equalsIgnoreCase(scheme)
                || "about".equalsIgnoreCase(scheme);
    }

    private boolean isTrustedStartPage(String url) {
        if (!isAssetUrl(url)) {
            return false;
        }
        Uri uri = Uri.parse(url);
        return "/android_asset/index.html".equals(uri.getPath());
    }

    public final class NativeBridge {
        @JavascriptInterface
        public String getAiProfiles() {
            return aiImportService == null ? AI_DISABLED : aiImportService.getProfiles();
        }

        @JavascriptInterface
        public String saveAiProfile(String id, String name, String endpoint, String model, String token) {
            return aiImportService == null ? AI_DISABLED
                    : aiImportService.saveProfile(id, name, endpoint, model, token);
        }

        @JavascriptInterface
        public String deleteAiProfile(String id) {
            return aiImportService == null ? AI_DISABLED : aiImportService.removeProfile(id);
        }

        @JavascriptInterface
        public String activateAiProfile(String id) {
            return aiImportService == null ? AI_DISABLED : aiImportService.activateProfile(id);
        }

        @JavascriptInterface
        public void testAiProfile(String id) {
            if (aiImportService == null) {
                emitAiDisabled("android-ai-profile-test", id);
                return;
            }
            boolean submitted = submitIo(new Runnable() {
                @Override
                public void run() {
                    String result = aiImportService.testProfile(id);
                    String payload = aiEventPayload(id, result);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (!destroyed) emitStringEvent("android-ai-profile-test", payload);
                        }
                    });
                }
            });
            if (!submitted) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        emitStringEvent("android-ai-profile-test",
                                aiEventPayload(id,
                                        "{\"ok\":false,\"message\":\"暂时无法启动测试\"}"));
                    }
                });
            }
        }

        @JavascriptInterface
        public void analyzeDayText(String requestJson) {
            String suppliedId = "";
            try {
                suppliedId = new JSONObject(requestJson).optString("requestId", "");
            } catch (JSONException ignored) {
                // The service returns a validation error for malformed input.
            }
            final String requestId = suppliedId.length() <= 100 ? suppliedId : "";
            if (aiImportService == null) {
                emitAiDisabled("android-ai-result", requestId);
                return;
            }
            boolean submitted = submitIo(new Runnable() {
                @Override
                public void run() {
                    String result = aiImportService.analyze(requestJson);
                    String eventPayload = aiEventPayload(requestId, result);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (!destroyed) emitStringEvent("android-ai-result", eventPayload);
                        }
                    });
                }
            });
            if (!submitted) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        emitStringEvent("android-ai-result",
                                aiEventPayload(requestId,
                                        "{\"ok\":false,\"message\":\"暂时无法启动识别\"}"));
                    }
                });
            }
        }

        @JavascriptInterface
        public void exportData(String json) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startExport(json);
                }
            });
        }

        @JavascriptInterface
        public void requestImport() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startImport();
                }
            });
        }

        @JavascriptInterface
        public void importData() {
            requestImport();
        }

        @JavascriptInterface
        public void setReminder(boolean enabled, String time) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!enabled) {
                        ReminderScheduler.disable(MainActivity.this);
                        showToast("每日提醒已关闭");
                        emitStringEvent("android-reminder-updated", "off");
                        return;
                    }
                    int[] hourMinute = ReminderScheduler.parseTime(time);
                    if (hourMinute == null) {
                        showToast("提醒时间格式不正确");
                        emitStringEvent("android-reminder-error", "invalid_time");
                        return;
                    }
                    ReminderScheduler.enable(
                            MainActivity.this,
                            hourMinute[0],
                            hourMinute[1]
                    );
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED) {
                        requestNotificationPermissionIfNeeded();
                        showToast("请允许通知，才能开启每日提醒");
                        return;
                    }
                    if (!NotificationHelper.canPostNotifications(MainActivity.this)) {
                        ReminderScheduler.disable(MainActivity.this);
                        showToast("系统通知已关闭，请先在设置中开启");
                        emitStringEvent("android-reminder-permission", "denied");
                        emitStringEvent("android-reminder-updated", "off");
                        return;
                    }
                    showToast(String.format(
                            Locale.CHINA,
                            "每天 %02d:%02d 温和提醒",
                            hourMinute[0],
                            hourMinute[1]
                    ));
                    emitStringEvent(
                            "android-reminder-updated",
                            String.format(Locale.ROOT, "%02d:%02d", hourMinute[0], hourMinute[1])
                    );
                }
            });
        }

        @JavascriptInterface
        public String getReminderState() {
            return ReminderScheduler.getStateJson(MainActivity.this);
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.openNotificationSettings();
                }
            });
        }

        @JavascriptInterface
        public void shareText(String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    sharePlainText(text);
                }
            });
        }

        @JavascriptInterface
        public void notify(String message) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showToast(message);
                }
            });
        }

        @JavascriptInterface
        public boolean isSystemDark() {
            return MainActivity.this.isSystemDark();
        }

        @JavascriptInterface
        public void setSystemTheme(boolean dark) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    configureSystemBars(dark);
                    if (webView != null) {
                        webView.setBackgroundColor(dark
                                ? Color.rgb(16, 22, 19)
                                : Color.rgb(247, 248, 244));
                    }
                }
            });
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }

    private String reminderTimeFromState() {
        try {
            return new JSONObject(ReminderScheduler.getStateJson(this))
                    .optString("time", "22:00");
        } catch (JSONException ignored) {
            return "22:00";
        }
    }

    @android.annotation.TargetApi(35)
    private static final class Api35Insets {
        private Api35Insets() {
        }

        static void apply(FrameLayout container) {
            container.setOnApplyWindowInsetsListener(
                    new View.OnApplyWindowInsetsListener() {
                        @Override
                        public android.view.WindowInsets onApplyWindowInsets(
                                View view,
                                android.view.WindowInsets insets
                        ) {
                            int handledTypes = android.view.WindowInsets.Type.systemBars()
                                    | android.view.WindowInsets.Type.displayCutout();
                            android.graphics.Insets bars = insets.getInsets(handledTypes);
                            // Edge-to-edge windows are not resized for the keyboard, so
                            // lift the WebView above the IME to keep focused fields and
                            // the sheet's bottom save button visible.
                            int imeType = android.view.WindowInsets.Type.ime();
                            android.graphics.Insets ime = insets.getInsets(imeType);
                            view.setPadding(bars.left, bars.top, bars.right,
                                    Math.max(bars.bottom, ime.bottom));
                            return new android.view.WindowInsets.Builder(insets)
                                    .setInsets(handledTypes, android.graphics.Insets.NONE)
                                    .setInsets(imeType, android.graphics.Insets.NONE)
                                    .build();
                        }
                    }
            );
        }
    }

    private final class OfflineWebViewClient extends WebViewClient {
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            pageReady = false;
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (!isTrustedStartPage(url)) {
                return;
            }
            pageReady = true;
            maybeDeliverPendingImport();
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return blockNavigationUnlessLocal(request.getUrl().toString());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return blockNavigationUnlessLocal(url);
        }

        private boolean blockNavigationUnlessLocal(String url) {
            if (isAssetUrl(url)) {
                return false;
            }
            showToast("为保护本地数据，应用不会打开外部网页");
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(
                WebView view,
                WebResourceRequest request
        ) {
            if (isSafeSubresource(request.getUrl().toString())) {
                return super.shouldInterceptRequest(view, request);
            }
            return blockedResponse();
        }

        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            if (isSafeSubresource(url)) {
                return super.shouldInterceptRequest(view, url);
            }
            return blockedResponse();
        }

        private WebResourceResponse blockedResponse() {
            return new WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    new ByteArrayInputStream(new byte[0])
            );
        }

        @Override
        public void onReceivedSslError(
                WebView view,
                SslErrorHandler handler,
                android.net.http.SslError error
        ) {
            handler.cancel();
        }

        @Override
        public void onReceivedError(
                WebView view,
                WebResourceRequest request,
                WebResourceError error
        ) {
            if (request.isForMainFrame()) {
                showToast("页面加载失败，请重新打开应用");
            }
        }
    }
}
