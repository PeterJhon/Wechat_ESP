// app.js
App({
  onLaunch() {
    console.log('蓝牙文件传输小程序启动')

    // 检查蓝牙权限
    this.checkBluetoothPermission()
  },

  /**
   * 检查蓝牙相关权限
   */
  checkBluetoothPermission() {
    // Android 需要位置权限才能扫描蓝牙设备
    const platform = wx.getSystemInfoSync().platform

    if (platform === 'android') {
      wx.getSetting({
        success: (res) => {
          if (!res.authSetting['scope.userLocation']) {
            wx.authorize({
              scope: 'scope.userLocation',
              success: () => {
                console.log('位置权限已授权')
              },
              fail: () => {
                console.log('位置权限被拒绝')
                wx.showModal({
                  title: '提示',
                  content: 'Android 设备需要位置权限才能扫描蓝牙设备',
                  showCancel: false
                })
              }
            })
          }
        }
      })
    }
  }
})
