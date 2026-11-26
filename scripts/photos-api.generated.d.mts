import type { PhotosApi } from "../lib/photos-commands"
import type { PhotosSession } from "../lib/photos-protocol"

export declare function createPhotosApi(session: PhotosSession): PhotosApi
