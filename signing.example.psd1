# 复制为本机签名配置后再修改，不要提交真实密码：
#   个人版：android\keystore\signing.personal.psd1
#   通用版：android\keystore\signing.local.psd1
# 路径可写相对仓库根目录的路径。首次构建会按此配置生成长期签名密钥。
@{
    KeystorePath  = "android\keystore\week168-release.jks"
    Alias         = "week168"
    StorePassword = "change-this-to-a-long-random-password"
    KeyPassword   = "change-this-to-a-long-random-password"
}
