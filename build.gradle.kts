plugins {
    id 'com.android.application'
    id 'org.jetbrains.kotlin.android' version '1.9.0'
}

android {
    compileSdk 34
    defaultConfig {
        applicationId "com.example.modernandroid"
        minSdk 24
        targetSdk 34
        versionCode 1
        versionName "1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
    buildTypes {
        release {
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
    composeOptions {
        kotlinCompilerExtensionVersion '1.5.1'
        version '1.6.0-alpha02' // Latest compose version
    }
    buildFeatures {
        compose true
    }
    kotlinOptions {
        jvmTarget '11'
    }
}

dependencies {
    // Core Libraries
    implementation 'androidx.core:core-ktx:1.10.1'
    implementation 'androidx.activity:activity-compose:1.7.3'

    // Jetpack Compose
    implementation 'androidx.compose.ui:ui:1.6.0-alpha02'
    implementation 'androidx.compose.material:material:1.6.0-alpha02'
    implementation 'androidx.compose.ui:ui-tooling:1.6.0-alpha02'
    implementation 'androidx.compose.ui:ui-test:1.6.0-alpha02'

    // Architecture
    implementation 'androidx.lifecycle:lifecycle-viewmodel-ktx:2.6.2'
    implementation 'androidx.lifecycle:lifecycle-runtime-ktx:2.6.2'
    implementation 'androidx.hilt:hilt-android:2.48.3'
    implementation 'androidx.hilt:hilt-compiler:2.48.3'

    // Networking
    implementation 'com.squareup.retrofit2:retrofit:2.9.3'
    implementation 'com.squareup.retrofit2:converter-gson:2.9.3'
    implementation 'com.squareup.okhttp3:logging-interceptor:4.9.3'

    // Database
    implementation 'androidx.room:room-runtime:2.5.2'
    kapt 'androidx.room:room-compiler:2.5.2'

    // Testing
    testImplementation 'junit:junit:4.13.2'
    androidTestImplementation 'androidx.test.ext:junit:1.1.5'
    androidTestImplementation 'androidx.compose.ui:ui-test:1.6.0-alpha02'
}