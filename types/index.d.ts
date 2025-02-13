import { Packument } from "@npm/types";


type ModifiedPackument = Omit<Packument, "_rev"> & { _rev?: string };
