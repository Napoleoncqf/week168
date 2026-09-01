@{
    # Copy this file to android/keystore/signing.local.psd1, then replace
    # both passwords before the first build. The destination is gitignored.
    KeystorePath = "android/keystore/week168-release.jks"
    Alias = "week168"
    StorePassword = "replace-with-a-long-random-password"
    KeyPassword = "replace-with-a-long-random-password"
}
