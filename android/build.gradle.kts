plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}

// Optional: keep build output off the project drive (scripts\env.ps1 sets this when the
// project sits on a slow or non-NTFS disk).
System.getenv("AM32_GRADLE_BUILD_DIR")?.takeIf { it.isNotBlank() }?.let { dir ->
    allprojects {
        layout.buildDirectory.set(File(dir, if (path == ":") "root" else name))
    }
}
