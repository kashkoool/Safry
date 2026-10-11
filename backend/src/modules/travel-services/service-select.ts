/** Shared projection of a travel service with its organization and package components. */
export const serviceInclude = {
  organization: { select: { id: true, name: true, nameAr: true, nameEn: true, type: true, status: true } },
  components: {
    include: {
      service: {
        select: {
          id: true,
          title: true,
          titleEn: true,
          category: true,
          status: true,
          organization: { select: { name: true, nameAr: true, nameEn: true } }
        }
      }
    }
  }
} as const;
