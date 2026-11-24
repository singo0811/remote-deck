# Allow the phone to reach the host agent over the LAN. Without these rules the
# host's "Public" network profile blocks inbound 9601/9602, so clients silently
# fall back to the Tailscale relay path (high latency).
$ErrorActionPreference = 'Stop'
$tcp = @{
  DisplayName = 'RemoteDeck Host (TCP 9601)'
  Direction   = 'Inbound'
  Protocol    = 'TCP'
  LocalPort   = 9601
  Action      = 'Allow'
  Profile     = 'Private,Public'
  RemoteAddress = 'LocalSubnet'
}
$udp = @{
  DisplayName = 'RemoteDeck Discovery (UDP 9602)'
  Direction   = 'Inbound'
  Protocol    = 'UDP'
  LocalPort   = 9602
  Action      = 'Allow'
  Profile     = 'Private,Public'
  RemoteAddress = 'LocalSubnet'
}
foreach ($spec in @($tcp, $udp)) {
  $existing = Get-NetFirewallRule -DisplayName $spec.DisplayName -ErrorAction SilentlyContinue
  if ($existing) {
    Set-NetFirewallRule -DisplayName $spec.DisplayName -Enabled True -Action Allow -Profile Any
    Write-Output "updated: $($spec.DisplayName)"
  } else {
    New-NetFirewallRule @spec | Out-Null
    Write-Output "created: $($spec.DisplayName)"
  }
}
Get-NetFirewallRule -DisplayName 'RemoteDeck*' |
  Select-Object DisplayName, Enabled, Direction, Action, Profile |
  Format-Table -AutoSize
