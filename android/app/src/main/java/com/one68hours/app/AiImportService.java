package com.one68hours.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;

/** Optional, user-triggered text recognition. The API key never enters WebView storage or backups. */
final class AiImportService {
    private static final int MAX_RESPONSE_BYTES = 128 * 1024;
    private static final int MAX_TEXT_LENGTH = 4000;
    private static final int CONNECT_TIMEOUT_MS = 20000;
    private static final int READ_TIMEOUT_MS = 90000;

    private final AiProfileStore profiles;

    AiImportService(Context context) {
        profiles = new AiProfileStore(context);
    }

    String getProfiles() {
        return profiles.publicState();
    }

    String saveProfile(String id, String name, String endpoint, String model, String token) {
        return profiles.save(id, name, endpoint, model, token);
    }

    String removeProfile(String id) {
        return profiles.remove(id);
    }

    String activateProfile(String id) {
        return profiles.activate(id);
    }

    String analyze(String requestJson) {
        try {
            if (requestJson == null || requestJson.length() > 16000) {
                return error("文字或分类列表过长");
            }
            JSONObject input = new JSONObject(requestJson);
            String date = input.optString("date", "");
            String text = input.optString("text", "").trim();
            JSONArray categories = input.optJSONArray("categories");
            SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            dateFormat.setLenient(false);
            try {
                if (!date.matches("\\d{4}-\\d{2}-\\d{2}")) throw new ParseException("date", 0);
                dateFormat.parse(date);
            } catch (ParseException ignored) {
                return error("请选择有效日期");
            }
            if (text.isEmpty() || text.length() > MAX_TEXT_LENGTH) {
                return error("请输入 1 到 4000 字的当天活动描述");
            }
            if (categories == null || categories.length() < 1 || categories.length() > 200) {
                return error("分类列表不正确");
            }
            for (int i = 0; i < categories.length(); i++) {
                JSONObject category = categories.optJSONObject(i);
                if (category == null || !category.optString("id", "").matches("[a-zA-Z0-9_-]{1,80}")
                        || category.optString("name", "").isEmpty()) {
                    return error("分类列表包含无效项目");
                }
            }
            AiProfileStore.Profile profile;
            try {
                profile = profiles.secret(input.optString("profileId", ""));
            } catch (IllegalStateException ignored) {
                return error("请先在设置中保存一组 API 配置");
            }
            String model = input.optString("model", "").trim();
            if (model.isEmpty()) model = profile.model;
            if (model.length() > 100 || model.indexOf('\n') >= 0 || model.indexOf('\r') >= 0) {
                return error("所选模型名称不正确");
            }
            URI uri = AiProfileStore.validatedEndpoint(profile.endpoint);
            JSONObject request = new JSONObject();
            request.put("model", model);
            JSONArray messages = new JSONArray();
            messages.put(new JSONObject()
                    .put("role", "system")
                    .put("content", systemPrompt()));
            messages.put(new JSONObject()
                    .put("role", "user")
                    .put("content", new JSONObject()
                            .put("date", date)
                            .put("categories", categories)
                            .put("text", text).toString()));
            request.put("messages", messages);
            if (AiProfileStore.DEFAULT_ENDPOINT.equals(uri.toString())) {
                request.put("thinking", new JSONObject().put("type",
                        input.optBoolean("deepThinking", false) ? "enabled" : "disabled"));
            }
            if (AiProfileStore.DEFAULT_ENDPOINT.equals(uri.toString())
                    && AiProfileStore.DEFAULT_MODEL.equals(model)) {
                request.put("response_format", new JSONObject().put("type", "json_object"));
            }

            ApiResponse reply = postChat(uri, profile.token, request);
            String problem = statusError(reply.status);
            if (problem != null) return error(problem);
            JSONObject completion = new JSONObject(reply.body);
            JSONArray choices = completion.optJSONArray("choices");
            JSONObject first = choices == null ? null : choices.optJSONObject(0);
            // A reply cut off at the output limit is half a JSON object; say so
            // instead of letting it surface as a generic parse failure.
            if (first != null && "length".equals(first.optString("finish_reason", ""))) {
                return error("这段文字太长，识别结果被截断。请分成上午、下午等几段分别识别");
            }
            JSONObject message = first == null ? null : first.optJSONObject("message");
            Object content = message == null ? null : message.opt("content");
            String modelText = extractText(content);
            if (modelText.isEmpty()) return error("模型没有返回活动列表");
            return new JSONObject().put("ok", true).put("content", modelText).toString();
        } catch (IOException failure) {
            return networkError(failure);
        } catch (Exception ignored) {
            return error("识别失败，请检查接口是否兼容 Chat Completions");
        }
    }

    String testProfile(String id) {
        try {
            AiProfileStore.Profile profile = profiles.secret(id);
            URI endpoint = AiProfileStore.validatedEndpoint(profile.endpoint);
            ModelsResponse discovered = fetchModels(endpoint, profile.token);
            boolean officialDeepSeek = "api.deepseek.com".equalsIgnoreCase(endpoint.getHost());
            if ((officialDeepSeek && (discovered.status == 401 || discovered.status == 403))
                    || discovered.status == 402 || discovered.status == 429
                    || discovered.status >= 500) {
                return error(statusError(discovered.status));
            }

            JSONObject request = new JSONObject()
                    .put("model", profile.model)
                    .put("messages", new JSONArray().put(new JSONObject()
                            .put("role", "user")
                            .put("content", "只回复 OK")));
            if (officialDeepSeek) {
                request.put("thinking", new JSONObject().put("type", "disabled"));
            }
            ApiResponse reply = postChat(endpoint, profile.token, request);
            String problem = statusError(reply.status);
            if (problem != null) return error(problem);
            JSONObject completion = new JSONObject(reply.body);
            JSONArray choices = completion.optJSONArray("choices");
            if (choices == null || choices.length() == 0) return error("接口已响应，但测试结果缺少模型输出");
            if (discovered.models.length() > 0) {
                try { profiles.cacheModels(profile.id, discovered.models); }
                catch (Exception ignored) { /* Keep the successful connection result. */ }
            }
            return new JSONObject().put("ok", true)
                    .put("message", "连接、API Key 和默认模型均可用；测试发送了固定短句")
                    .put("models", discovered.models).toString();
        } catch (IllegalStateException ignored) {
            return error("请先保存一组 API 配置");
        } catch (IOException failure) {
            return networkError(failure);
        } catch (Exception ignored) {
            return error("测试失败，请检查配置与服务商兼容格式");
        }
    }

    private static ModelsResponse fetchModels(URI endpoint, String token) throws Exception {
        String chatPath = endpoint.getPath();
        String basePath = chatPath.substring(0, chatPath.length() - "/chat/completions".length());
        URI modelsUri = new URI(endpoint.getScheme(), null, endpoint.getHost(), endpoint.getPort(),
                basePath + "/models", null, null);
        HttpsURLConnection connection = (HttpsURLConnection) modelsUri.toURL().openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            JSONArray models = new JSONArray();
            if (status == 200) {
                String response = readLimited(connection.getInputStream());
                try {
                    JSONArray data = new JSONObject(response).optJSONArray("data");
                    if (data != null) {
                        for (int index = 0; index < data.length() && models.length() < 50; index++) {
                            JSONObject item = data.optJSONObject(index);
                            if (item == null) continue;
                            String modelId = item.optString("id", "").trim();
                            if (modelId.isEmpty() || modelId.length() > 100) continue;
                            String name = item.optString("name", modelId).trim();
                            if (name.isEmpty()) name = modelId;
                            models.put(new JSONObject().put("id", modelId)
                                    .put("name", name.substring(0, Math.min(100, name.length()))));
                        }
                    }
                } catch (JSONException ignored) {
                    // Some compatible providers do not use the /models response schema.
                }
            }
            return new ModelsResponse(status, models);
        } finally {
            connection.disconnect();
        }
    }

    private static ApiResponse postChat(URI endpoint, String token, JSONObject request) throws IOException {
        HttpsURLConnection connection = (HttpsURLConnection) endpoint.toURL().openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + token);
            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            int status = connection.getResponseCode();
            String response = status >= 200 && status < 300
                    ? readLimited(connection.getInputStream()) : "";
            return new ApiResponse(status, response);
        } finally {
            connection.disconnect();
        }
    }

    private static String statusError(int status) {
        if (status >= 200 && status < 300) return null;
        if (status == 400) return "服务商拒绝请求（HTTP 400），请检查模型名和接口格式";
        if (status == 401 || status == 403) return "接口拒绝了 API Key，请检查密钥和模型权限";
        if (status == 402) return "接口余额不足，请检查服务商账户";
        if (status == 404) return "接口或模型不存在，请检查服务商配置";
        if (status == 429) return "请求过于频繁或额度不足，请稍后重试";
        if (status >= 300 && status < 400) return "接口重定向已被拒绝，请填写最终 HTTPS 地址";
        return "服务商返回 HTTP " + status;
    }

    private static final class ApiResponse {
        final int status;
        final String body;
        ApiResponse(int status, String body) { this.status = status; this.body = body; }
    }

    private static final class ModelsResponse {
        final int status;
        final JSONArray models;
        ModelsResponse(int status, JSONArray models) { this.status = status; this.models = models; }
    }

    private static String systemPrompt() {
        return "你是个人时间记录解析器。仅根据用户当天原文提取活动，不补造时间。"
                + "仅返回 JSON 对象，结构为 {\"items\":[{\"start\":\"HH:mm\",\"end\":\"HH:mm\","
                + "\"categoryId\":\"分类ID\",\"content\":\"简短内容\",\"inferred\":false}],"
                + "\"unresolved\":[{\"text\":\"原文片段\",\"reason\":\"无法确定的原因\"}]}。"
                + "最多 48 段。时间必须是 15 分钟刻度；明确到次日零点可用 24:00。"
                + "若前一活动只有明确开始时间，而下一活动有明确开始时间，可把下一活动开始作为前一活动结束，设置 inferred=true。"
                + "没有足够时间锚点、无法按 15 分钟刻度表达、或不确定属于所选日期的活动，放到 unresolved。"
                + "不要推测空白时间，不要将计划当成已发生事实。categoryId 只能从用户提供的列表选择。"
                + "不得输出 Markdown 或任何 JSON 以外的文字。";
    }

    private static String readLimited(InputStream stream) throws IOException {
        try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > MAX_RESPONSE_BYTES) throw new IOException("response too large");
                out.write(buffer, 0, count);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String extractText(Object content) {
        if (content instanceof String) return ((String) content).trim();
        if (!(content instanceof JSONArray)) return "";
        StringBuilder text = new StringBuilder();
        JSONArray parts = (JSONArray) content;
        for (int i = 0; i < parts.length(); i++) {
            JSONObject part = parts.optJSONObject(i);
            if (part != null) text.append(part.optString("text", ""));
        }
        return text.toString().trim();
    }

    private static String success(String message) {
        try { return new JSONObject().put("ok", true).put("message", message).toString(); }
        catch (JSONException ignored) { return "{\"ok\":true}"; }
    }

    private static String error(String message) {
        try { return new JSONObject().put("ok", false).put("message", message).toString(); }
        catch (JSONException ignored) { return "{\"ok\":false}"; }
    }

    private static String networkError(IOException failure) {
        if (failure instanceof UnknownHostException) {
            return error("无法解析服务商域名，请检查手机网络、私人 DNS 或 VPN 设置");
        }
        if (failure instanceof SSLHandshakeException || failure instanceof SSLException) {
            return error("HTTPS 握手失败，请检查手机时间、代理或证书设置");
        }
        if (failure instanceof SocketTimeoutException) {
            return error("连接或响应超时，请切换 Wi-Fi/移动网络后重试");
        }
        if (failure instanceof ConnectException || failure instanceof NoRouteToHostException) {
            return error("无法连接服务商，请检查手机网络、VPN 或代理设置");
        }
        return error("网络连接中断，请切换网络后重试");
    }

}
