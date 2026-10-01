package com.one68hours.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Local API profiles. Keys are encrypted with AndroidKeyStore and never returned to WebView. */
final class AiProfileStore {
    static final String DEFAULT_ENDPOINT = "https://api.deepseek.com/chat/completions";
    static final String DEFAULT_MODEL = "deepseek-flash";

    private static final String PREFS = "week168_ai_settings";
    private static final String KEY_ALIAS = "week168_ai_key_v1";
    private static final String PROFILES_PREF = "profiles_v2";
    private static final String ACTIVE_PREF = "active_profile_id";
    private static final String LEGACY_URL = "endpoint";
    private static final String LEGACY_MODEL = "model";
    private static final String LEGACY_TOKEN = "encrypted_token";
    private static final int MAX_PROFILES = 20;

    private final SharedPreferences prefs;

    AiProfileStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static URI validatedEndpoint(String input) throws Exception {
        URI uri = new URI(String.valueOf(input == null ? "" : input).trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                || uri.getRawFragment() != null || !uri.getPath().endsWith("/chat/completions")
                || uri.toString().length() > 500) {
            throw new IllegalArgumentException("invalid endpoint");
        }
        return uri;
    }

    synchronized String publicState() {
        try {
            JSONArray stored = load();
            JSONArray visible = new JSONArray();
            for (int index = 0; index < stored.length(); index++) {
                JSONObject item = stored.getJSONObject(index);
                visible.put(new JSONObject()
                        .put("id", item.getString("id"))
                        .put("name", item.getString("name"))
                        .put("endpoint", item.getString("endpoint"))
                        .put("model", item.getString("model"))
                        .put("hasKey", !item.optString("token", "").isEmpty())
                        .put("models", item.optJSONArray("models") == null
                                ? new JSONArray() : item.getJSONArray("models")));
            }
            return new JSONObject()
                    .put("ok", true)
                    .put("activeId", prefs.getString(ACTIVE_PREF, ""))
                    .put("profiles", visible).toString();
        } catch (Exception ignored) {
            return error("本机 API 配置无法读取；原内容未被覆盖");
        }
    }

    synchronized String save(String id, String name, String endpoint, String model, String token) {
        try {
            URI uri = validatedEndpoint(endpoint);
            String cleanModel = String.valueOf(model == null ? "" : model).trim();
            if (cleanModel.isEmpty() || cleanModel.length() > 100) return error("模型名需为 1–100 个字");
            String cleanName = String.valueOf(name == null ? "" : name).trim();
            if (cleanName.isEmpty()) cleanName = DEFAULT_ENDPOINT.equals(uri.toString()) ? "DeepSeek" : uri.getHost();
            if (cleanName.length() > 30) return error("配置名称不能超过 30 个字");
            String cleanToken = String.valueOf(token == null ? "" : token).trim();
            if (cleanToken.length() > 4096 || cleanToken.indexOf('\n') >= 0 || cleanToken.indexOf('\r') >= 0) {
                return error("API Key 格式不正确");
            }
            JSONArray items = load();
            String existingId = String.valueOf(id == null ? "" : id).trim();
            int position = indexOf(items, existingId);
            JSONObject previous = position < 0 ? null : items.getJSONObject(position);
            if (!existingId.isEmpty() && previous == null) return error("这组配置已不存在，请重新选择");
            if (previous == null && items.length() >= MAX_PROFILES) return error("最多保存 20 组 API 配置");
            if (cleanToken.isEmpty() && previous == null) return error("请输入 API Key");
            if (cleanToken.isEmpty() && previous != null
                    && previous.optString("token", "").isEmpty()) return error("请输入 API Key");
            if (cleanToken.isEmpty() && previous != null
                    && !uri.toString().equals(previous.getString("endpoint"))) {
                return error("更换接口地址时，请输入新服务商的 API Key");
            }
            String savedToken = cleanToken.isEmpty() ? previous.getString("token") : encrypt(cleanToken);
            String savedId = previous == null ? UUID.randomUUID().toString() : existingId;
            JSONArray models = previous != null && uri.toString().equals(previous.getString("endpoint"))
                    ? previous.optJSONArray("models") : null;
            JSONObject updated = new JSONObject()
                    .put("id", savedId).put("name", cleanName)
                    .put("endpoint", uri.toString()).put("model", cleanModel)
                    .put("token", savedToken)
                    .put("models", models == null ? new JSONArray() : models);
            if (position < 0) items.put(updated);
            else items.put(position, updated);
            String activeId = prefs.getString(ACTIVE_PREF, "");
            if (activeId.isEmpty()) activeId = savedId;
            if (!prefs.edit().putString(PROFILES_PREF, items.toString())
                    .putString(ACTIVE_PREF, activeId).commit()) {
                return error("配置保存失败，请检查设备存储空间");
            }
            return new JSONObject().put("ok", true).put("id", savedId)
                    .put("message", "配置已加密保存在本机").toString();
        } catch (Exception ignored) {
            return error("保存失败，请检查 HTTPS 地址和 API Key");
        }
    }

    synchronized String remove(String id) {
        try {
            JSONArray source = load();
            if (indexOf(source, id) < 0) return error("配置已不存在");
            JSONArray retained = new JSONArray();
            for (int index = 0; index < source.length(); index++) {
                JSONObject item = source.getJSONObject(index);
                if (!id.equals(item.getString("id"))) retained.put(item);
            }
            String activeId = prefs.getString(ACTIVE_PREF, "");
            if (id.equals(activeId)) activeId = retained.length() == 0
                    ? "" : retained.getJSONObject(0).getString("id");
            if (!prefs.edit().putString(PROFILES_PREF, retained.toString())
                    .putString(ACTIVE_PREF, activeId).commit()) return error("删除失败");
            return success("配置和对应密钥已从本机移除");
        } catch (Exception ignored) {
            return error("无法删除这组配置");
        }
    }

    synchronized String activate(String id) {
        try {
            if (indexOf(load(), id) < 0) return error("配置已不存在");
            return prefs.edit().putString(ACTIVE_PREF, id).commit()
                    ? success("已设为默认配置") : error("默认配置保存失败");
        } catch (Exception ignored) {
            return error("无法切换配置");
        }
    }

    synchronized Profile secret(String requestedId) throws Exception {
        JSONArray items = load();
        String id = String.valueOf(requestedId == null ? "" : requestedId).trim();
        if (id.isEmpty()) id = prefs.getString(ACTIVE_PREF, "");
        int position = indexOf(items, id);
        if (position < 0) throw new IllegalStateException("no profile");
        JSONObject item = items.getJSONObject(position);
        return new Profile(item.getString("id"), item.getString("name"),
                item.getString("endpoint"), item.getString("model"),
                decrypt(item.getString("token")));
    }

    synchronized void cacheModels(String id, JSONArray models) throws Exception {
        JSONArray items = load();
        int position = indexOf(items, id);
        if (position < 0) return;
        JSONObject item = items.getJSONObject(position);
        item.put("models", models);
        if (!prefs.edit().putString(PROFILES_PREF, items.toString()).commit()) {
            throw new IllegalStateException("models not saved");
        }
    }

    private JSONArray load() throws Exception {
        if (!prefs.contains(PROFILES_PREF)) migrateLegacy();
        JSONArray result = new JSONArray(prefs.getString(PROFILES_PREF, "[]"));
        if (result.length() > MAX_PROFILES) throw new JSONException("too many profiles");
        return result;
    }

    private void migrateLegacy() throws Exception {
        JSONArray result = new JSONArray();
        String encrypted = prefs.getString(LEGACY_TOKEN, "");
        String activeId = "";
        if (!encrypted.isEmpty()) {
            decrypt(encrypted);
            String endpoint = prefs.getString(LEGACY_URL, DEFAULT_ENDPOINT);
            String model = prefs.getString(LEGACY_MODEL, DEFAULT_MODEL);
            if (endpoint.isEmpty()) endpoint = DEFAULT_ENDPOINT;
            if (model.isEmpty()) model = DEFAULT_MODEL;
            URI uri = validatedEndpoint(endpoint);
            activeId = UUID.randomUUID().toString();
            result.put(new JSONObject().put("id", activeId)
                    .put("name", DEFAULT_ENDPOINT.equals(uri.toString()) ? "DeepSeek" : "原有配置")
                    .put("endpoint", uri.toString()).put("model", model)
                    .put("token", encrypted).put("models", new JSONArray()));
        }
        if (!prefs.edit().putString(PROFILES_PREF, result.toString())
                .putString(ACTIVE_PREF, activeId)
                .remove(LEGACY_URL).remove(LEGACY_MODEL).remove(LEGACY_TOKEN).commit()) {
            throw new IllegalStateException("migration failed");
        }
    }

    private static int indexOf(JSONArray items, String id) throws JSONException {
        if (id == null || id.isEmpty()) return -1;
        for (int index = 0; index < items.length(); index++) {
            if (id.equals(items.getJSONObject(index).getString("id"))) return index;
        }
        return -1;
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(128).build());
        return generator.generateKey();
    }

    private static String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    }

    private static String decrypt(String saved) throws Exception {
        String[] parts = saved.split(":", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid key blob");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(),
                new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private static String success(String message) {
        try { return new JSONObject().put("ok", true).put("message", message).toString(); }
        catch (JSONException ignored) { return "{\"ok\":true}"; }
    }

    private static String error(String message) {
        try { return new JSONObject().put("ok", false).put("message", message).toString(); }
        catch (JSONException ignored) { return "{\"ok\":false}"; }
    }

    static final class Profile {
        final String id;
        final String name;
        final String endpoint;
        final String model;
        final String token;

        Profile(String id, String name, String endpoint, String model, String token) {
            this.id = id;
            this.name = name;
            this.endpoint = endpoint;
            this.model = model;
            this.token = token;
        }
    }
}
