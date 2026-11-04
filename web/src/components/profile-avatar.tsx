import { isLocalProfilePhoto } from "@shared/profile-photo"
import { UserRound } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/avatar"

export function ProfileAvatar({ src, size = 36, label = "Profile photo" }: { src?: string | null; size?: number; label?: string }) {
  return <Avatar style={{ width: size, height: size }}><AvatarImage src={isLocalProfilePhoto(src) ? src : undefined} alt={label} /><AvatarFallback className="bg-avatar-background text-avatar-foreground" aria-label="No profile photo"><UserRound className="size-1/2" aria-hidden="true" /></AvatarFallback></Avatar>
}
